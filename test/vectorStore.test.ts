import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway temp DB BEFORE importing the module (env is
// read lazily per call, but keep it deterministic across the suite).
let dir: string;

async function freshStore() {
  // Re-import with a unique path each test for isolation.
  const mod = await import("@/lib/rag/vectorStore");
  return mod;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "norne-vec-"));
  process.env.VECTOR_STORE_PATH = join(dir, "vectors.db");
});

afterEach(async () => {
  const { closeVectorStore } = await import("@/lib/rag/vectorStore");
  await closeVectorStore();
  rmSync(dir, { recursive: true, force: true });
});

function chunk(i: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    documentId: "doc1",
    documentName: "plan.txt",
    fileType: "txt",
    sheetName: null,
    chunkIndex: i,
    text: `chunk ${i}`,
    ...over,
  };
}

describe("vectorStore", () => {
  it("upserts and finds the nearest vector", async () => {
    const store = await freshStore();
    await store.ensureVectorStore();
    await store.upsertDocumentChunks(
      "doc1",
      [chunk(0, { text: "x axis" }), chunk(1, { text: "y axis" }), chunk(2, { text: "near x" })],
      [
        [1, 0, 0],
        [0, 1, 0],
        [0.9, 0.1, 0],
      ],
    );
    expect(await store.vectorCount()).toBe(3);

    const hits = await store.searchVectors([1, 0, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].text).toBe("x axis");
    expect(hits[0].similarity).toBeGreaterThan(0.99);
    expect(hits[1].text).toBe("near x");
  });

  it("replaces a document's chunks on re-upsert (no duplicates)", async () => {
    const store = await freshStore();
    await store.ensureVectorStore();
    await store.upsertDocumentChunks("doc1", [chunk(0)], [[1, 0, 0]]);
    await store.upsertDocumentChunks("doc1", [chunk(0), chunk(1)], [[1, 0, 0], [0, 1, 0]]);
    expect(await store.vectorCount()).toBe(2);
  });

  it("deletes a document's vectors", async () => {
    const store = await freshStore();
    await store.ensureVectorStore();
    await store.upsertDocumentChunks(
      "doc1",
      [chunk(0), chunk(1)],
      [[1, 0, 0], [0, 1, 0]],
    );
    await store.deleteDocumentVectors("doc1");
    expect(await store.vectorCount()).toBe(0);
    expect(await store.searchVectors([1, 0, 0], 5)).toHaveLength(0);
  });

  it("rejects a dimension change without a rebuild", async () => {
    const store = await freshStore();
    await store.ensureVectorStore();
    await store.upsertDocumentChunks("doc1", [chunk(0)], [[1, 0, 0]]);
    await expect(
      store.upsertDocumentChunks("doc2", [chunk(0)], [[1, 0, 0, 0]]),
    ).rejects.toThrow(/dimension/i);
  });

  it("returns 0 / empty when the store was never built", async () => {
    const store = await freshStore();
    expect(await store.vectorCount()).toBe(0);
    expect(await store.searchVectors([1, 0, 0], 5)).toHaveLength(0);
  });
});
