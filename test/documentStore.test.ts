import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteDocument,
  getAllChunks,
  listDocuments,
  saveDocument,
} from "@/lib/documents/store";
import type { DocumentChunk } from "@/lib/documents/types";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "norne-store-"));
  // Nested path to verify the directory is auto-created.
  file = path.join(dir, "nested", "knowledge-documents.json");
  process.env.DOCUMENT_STORE_PATH = file;
});

afterEach(() => {
  delete process.env.DOCUMENT_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function chunk(i: number, over: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    documentId: "D1",
    documentName: "bemanning.xlsx",
    fileType: "xlsx",
    sheetName: "Ark1",
    chunkIndex: i,
    text: `tekst ${i}`,
    uploadedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("local document store", () => {
  it("returns empty results when the store file does not exist yet", async () => {
    expect(await listDocuments()).toEqual([]);
    expect(await getAllChunks()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it("creates the directory + file and persists metadata and chunks", async () => {
    await saveDocument(
      { id: "D1", name: "bemanning.xlsx", fileType: "xlsx", uploadedAt: "2026-01-01T00:00:00Z" },
      [chunk(0), chunk(1)],
    );

    expect(existsSync(file)).toBe(true);
    const json = JSON.parse(readFileSync(file, "utf8"));
    expect(json.documents).toHaveLength(1);
    expect(json.documents[0]).toMatchObject({
      id: "D1",
      name: "bemanning.xlsx",
      fileType: "xlsx",
      uploadedAt: "2026-01-01T00:00:00Z",
      chunkCount: 2,
    });
    expect(json.documents[0].chunks[0]).toMatchObject({
      documentName: "bemanning.xlsx",
      sheetName: "Ark1",
      chunkIndex: 0,
      text: "tekst 0",
    });
  });

  it("lists documents (metadata only) and exposes chunks for search", async () => {
    await saveDocument(
      { id: "D1", name: "bemanning.xlsx", fileType: "xlsx", uploadedAt: "2026-01-02T00:00:00Z" },
      [chunk(0), chunk(1)],
    );

    const docs = await listDocuments();
    expect(docs).toEqual([
      {
        id: "D1",
        name: "bemanning.xlsx",
        fileType: "xlsx",
        uploadedAt: "2026-01-02T00:00:00Z",
        chunkCount: 2,
      },
    ]);

    const chunks = await getAllChunks();
    expect(chunks).toHaveLength(2);
    expect(chunks[0].sheetName).toBe("Ark1");
  });

  it("maps a null sheetName to undefined in search chunks", async () => {
    await saveDocument(
      { id: "T1", name: "notat.txt", fileType: "txt", uploadedAt: "2026-01-01T00:00:00Z" },
      [chunk(0, { documentId: "T1", documentName: "notat.txt", fileType: "txt", sheetName: null })],
    );
    const chunks = await getAllChunks();
    expect(chunks[0].sheetName).toBeUndefined();
  });

  it("replaces a document with the same id instead of duplicating", async () => {
    const meta = { id: "D1", name: "v1.txt", fileType: "txt", uploadedAt: "2026-01-01T00:00:00Z" };
    await saveDocument(meta, [chunk(0)]);
    await saveDocument({ ...meta, name: "v2.txt" }, [chunk(0), chunk(1)]);

    const docs = await listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("v2.txt");
    expect(docs[0].chunkCount).toBe(2);
  });

  it("deletes a document and its chunks", async () => {
    await saveDocument(
      { id: "D1", name: "a.txt", fileType: "txt", uploadedAt: "2026-01-01T00:00:00Z" },
      [chunk(0)],
    );
    await deleteDocument("D1");
    expect(await listDocuments()).toEqual([]);
    expect(await getAllChunks()).toEqual([]);
  });
});
