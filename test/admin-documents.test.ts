import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the document store so the route never touches the real filesystem.
vi.mock("@/lib/documents/store", () => ({
  listDocuments: vi.fn(),
  saveDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getAllChunks: vi.fn(),
  isFilesystemPermissionError: (e: unknown) =>
    ["EACCES", "EPERM", "EROFS"].includes(
      (e as NodeJS.ErrnoException)?.code ?? "",
    ),
}));

import { GET } from "@/app/api/admin/documents/route";
import { listDocuments } from "@/lib/documents/store";

const mList = vi.mocked(listDocuments);
const TOKEN = "test-admin-token";

let errSpy: ReturnType<typeof vi.spyOn>;
let logs: string[];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_UPLOAD_TOKEN = TOKEN;
  logs = [];
  errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    logs.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  errSpy.mockRestore();
  delete process.env.ADMIN_UPLOAD_TOKEN;
});

function authedRequest() {
  return new Request("http://localhost/api/admin/documents", {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

describe("GET /api/admin/documents", () => {
  it("returns [] (200) when knowledge_documents is empty", async () => {
    mList.mockResolvedValue([]);
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.documents).toEqual([]);
  });

  it("returns a clear error when the store file is not writable/readable", async () => {
    mList.mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
    );
    const res = await GET(authedRequest());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toMatch(/DOCUMENT_STORE_PATH/);
    expect(body.requestId).toBeTruthy();
  });

  it("logs admin_documents_error (not chat_error) with a safe message", async () => {
    mList.mockRejectedValue(new Error("boom from firestore"));
    await GET(authedRequest());
    const joined = logs.join("\n");
    expect(joined).toContain('"evt":"admin_documents_error"');
    expect(joined).toContain('"action":"list"');
    expect(joined).toContain("boom from firestore");
    expect(joined).not.toContain("chat_error");
  });

  it("rejects requests without a valid token (401)", async () => {
    const res = await GET(new Request("http://localhost/api/admin/documents"));
    expect(res.status).toBe(401);
    expect(mList).not.toHaveBeenCalled();
  });

  it("returns 503 when no admin token is configured", async () => {
    delete process.env.ADMIN_UPLOAD_TOKEN;
    const res = await GET(authedRequest());
    expect(res.status).toBe(503);
  });
});
