import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDriveItem } from "@/lib/sharepoint/types";

// --- Mocks -----------------------------------------------------------------
const graph = vi.hoisted(() => ({
  pages: [] as Array<{
    items: GraphDriveItem[];
    nextLink?: string;
    deltaLink?: string;
  }>,
  calls: 0,
}));

vi.mock("@/lib/sharepoint/graphClient", () => ({
  resolveSiteId: async () => "site-1",
  listDrives: async () => [{ id: "drive-1", name: "Docs" }],
  deltaPage: async () => graph.pages[graph.calls++],
  folderDeltaPage: async () => graph.pages[graph.calls++],
  resolveFolderId: async (_driveId: string, path: string) =>
    path === "General/Kunde/Nornebygg" ? "folder-1" : null,
  downloadItem: async () => Buffer.from("hello world"),
}));

const stateStore = vi.hoisted(() => ({ state: { cursors: {} as Record<string, string> } }));
vi.mock("@/lib/sharepoint/syncState", () => ({
  readSyncState: async () => stateStore.state,
  writeSyncState: async (s: unknown) => {
    stateStore.state = s as typeof stateStore.state;
  },
}));

vi.mock("@/lib/documents/extract", () => ({
  fileTypeFromName: (name: string) => {
    const ext = name.split(".").pop() ?? "";
    if (!["pdf", "docx", "txt", "csv", "xlsx"].includes(ext)) throw new Error("x");
    return ext;
  },
  extractText: async (_buf: Buffer, name: string) => ({
    fileType: name.split(".").pop(),
    segments: [{ text: "some indexable content here" }],
  }),
}));

const saved = vi.hoisted(() => ({
  saveDocument: vi.fn(async () => {}),
  deleteDocument: vi.fn(async () => {}),
}));
vi.mock("@/lib/documents/store", () => ({
  saveDocument: saved.saveDocument,
  deleteDocument: saved.deleteDocument,
}));

const indexed = vi.hoisted(() => ({
  indexDocumentChunks: vi.fn(),
  removeDocumentFromIndex: vi.fn(),
}));
vi.mock("@/lib/rag/indexDocument", () => indexed);

function file(id: string, name: string, size = 100): GraphDriveItem {
  return { id, name, size, file: { mimeType: "text/plain" } };
}

import { syncBatch } from "@/lib/sharepoint/sync";

beforeEach(() => {
  graph.pages = [];
  graph.calls = 0;
  stateStore.state = { cursors: {} };
  saved.saveDocument.mockClear();
  saved.deleteDocument.mockClear();
  indexed.indexDocumentChunks.mockClear();
  indexed.removeDocumentFromIndex.mockClear();
  process.env.SHAREPOINT_ENABLED = "true";
  process.env.SHAREPOINT_TENANT_ID = "t";
  process.env.SHAREPOINT_CLIENT_ID = "c";
  process.env.SHAREPOINT_CLIENT_SECRET = "s";
  process.env.SHAREPOINT_SITE = "host:/sites/Docs";
  delete process.env.SHAREPOINT_DRIVES;
  delete process.env.SHAREPOINT_FOLDER;
});

describe("syncBatch", () => {
  it("pages through a drive and finishes at the deltaLink", async () => {
    graph.pages = [
      { items: [file("1", "a.txt"), file("2", "b.pdf")], nextLink: "L2" },
      { items: [file("3", "c.docx")], deltaLink: "DELTA" },
    ];
    const r = await syncBatch({ maxFiles: 50 });
    expect(r.indexed).toBe(3);
    expect(r.done).toBe(true);
    expect(saved.saveDocument).toHaveBeenCalledTimes(3);
    expect(indexed.indexDocumentChunks).toHaveBeenCalledTimes(3);
    // Cursor advanced to the deltaLink for incremental next run.
    expect(stateStore.state.cursors["drive-1"]).toBe("DELTA");
  });

  it("stops at the budget and reports not-done (resumable)", async () => {
    graph.pages = [
      { items: [file("1", "a.txt"), file("2", "b.txt")], nextLink: "L2" },
      { items: [file("3", "c.txt")], deltaLink: "DELTA" },
    ];
    const r = await syncBatch({ maxFiles: 2 });
    expect(r.indexed).toBe(2);
    expect(r.done).toBe(false);
    // Resume cursor is the nextLink, not the deltaLink.
    expect(stateStore.state.cursors["drive-1"]).toBe("L2");
  });

  it("skips unsupported types and oversized files", async () => {
    graph.pages = [
      {
        items: [
          file("1", "a.txt"),
          file("2", "image.png"), // unsupported
          file("3", "huge.pdf", 999 * 1024 * 1024), // too large
        ],
        deltaLink: "DELTA",
      },
    ];
    const r = await syncBatch({ maxFiles: 50 });
    expect(r.indexed).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.skippedReasons.unsupported).toBe(1);
    expect(r.skippedReasons.too_large).toBe(1);
  });

  it("removes documents for deleted tombstones", async () => {
    graph.pages = [
      {
        items: [{ id: "9", deleted: { state: "deleted" } } as GraphDriveItem],
        deltaLink: "DELTA",
      },
    ];
    const r = await syncBatch({ maxFiles: 50 });
    expect(r.removed).toBe(1);
    expect(saved.deleteDocument).toHaveBeenCalledWith("sp:drive-1:9");
    expect(indexed.removeDocumentFromIndex).toHaveBeenCalledWith("sp:drive-1:9");
  });

  it("throws when not configured", async () => {
    process.env.SHAREPOINT_ENABLED = "false";
    await expect(syncBatch()).rejects.toThrow(/not configured/i);
  });

  it("folder mode: scopes the delta to the configured folder", async () => {
    process.env.SHAREPOINT_FOLDER = "General/Kunde/Nornebygg";
    graph.pages = [
      { items: [file("1", "a.txt"), file("2", "b.pdf")], deltaLink: "DELTA" },
    ];
    const r = await syncBatch({ maxFiles: 50 });
    expect(r.indexed).toBe(2);
    expect(r.done).toBe(true);
    // Cursor stored under the composite drive:folder key.
    expect(stateStore.state.cursors["drive-1:folder-1"]).toBe("DELTA");
  });

  it("folder mode: throws when the folder is not found in any drive", async () => {
    process.env.SHAREPOINT_FOLDER = "Finnes/Ikke";
    await expect(syncBatch({ maxFiles: 50 })).rejects.toThrow(/not found/i);
  });
});
