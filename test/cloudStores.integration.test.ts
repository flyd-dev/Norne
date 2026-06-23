/**
 * Integration test for the cloud (Turso) storage backend — the Firestore
 * replacement for the app's own state. SKIPPED unless TURSO_DATABASE_URL is set,
 * so it never runs in CI; run it manually against a real Turso DB:
 *
 *   STORE_BACKEND=cloud VECTOR_BACKEND=turso \
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
 *   npx vitest run test/cloudStores.integration.test.ts
 *
 * Exercises the real store modules (no mocks) and cleans up its own rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasTurso = Boolean(process.env.TURSO_DATABASE_URL);
const TEST_DOC_ID = "__inttest__doc__";
const TEST_KV_KEY = "__inttest__kv__";

describe.skipIf(!hasTurso)("cloud stores (Turso) integration", () => {
  beforeAll(() => {
    process.env.STORE_BACKEND = "cloud";
    process.env.VECTOR_BACKEND = "turso";
  });

  afterAll(async () => {
    // Best-effort cleanup of anything this test wrote.
    const { getTursoClient, closeTursoClient } = await import("@/lib/turso/client");
    const c = await getTursoClient();
    await c.execute({ sql: "DELETE FROM kb_documents WHERE id = ?", args: [TEST_DOC_ID] }).catch(() => {});
    await c.execute({ sql: "DELETE FROM app_kv WHERE key = ?", args: [TEST_KV_KEY] }).catch(() => {});
    await c.execute({ sql: "DELETE FROM feedback WHERE timestamp = ?", args: ["__inttest__ts__"] }).catch(() => {});
    closeTursoClient();
  });

  it("app_kv: writes and reads back a state doc", async () => {
    const { readStateDoc, writeStateDoc } = await import("@/lib/firestore/appStore");
    await writeStateDoc(TEST_KV_KEY, { hello: "verden", n: 42 });
    const got = await readStateDoc<{ hello: string; n: number }>(TEST_KV_KEY);
    expect(got).toEqual({ hello: "verden", n: 42 });
  });

  it("documents: save, list, getAllChunks, delete", async () => {
    const { saveDocument, listDocuments, getAllChunks, deleteDocument } =
      await import("@/lib/documents/store");
    await saveDocument(
      { id: TEST_DOC_ID, name: "inttest.txt", fileType: "txt", uploadedAt: "2026-06-23T00:00:00.000Z" },
      [
        { documentId: TEST_DOC_ID, documentName: "inttest.txt", fileType: "txt", sheetName: null, chunkIndex: 0, text: "PURPURFISK", uploadedAt: "2026-06-23T00:00:00.000Z" },
        { documentId: TEST_DOC_ID, documentName: "inttest.txt", fileType: "txt", sheetName: null, chunkIndex: 1, text: "betong", uploadedAt: "2026-06-23T00:00:00.000Z" },
      ],
    );
    const list = await listDocuments();
    expect(list.find((d) => d.id === TEST_DOC_ID)?.chunkCount).toBe(2);

    const chunks = await getAllChunks();
    const mine = chunks.filter((ch) => ch.documentId === TEST_DOC_ID);
    expect(mine.map((ch) => ch.text).sort()).toEqual(["PURPURFISK", "betong"]);

    await deleteDocument(TEST_DOC_ID);
    expect((await listDocuments()).find((d) => d.id === TEST_DOC_ID)).toBeUndefined();
  });

  it("feedback: append and list", async () => {
    const { appendFeedback, listFeedback } = await import("@/lib/feedback/store");
    const rec = await appendFeedback({
      rating: "good",
      question: "inttest q",
      answer: "inttest a",
      sources: ["x"],
      route: "test",
      correction: null,
    });
    expect(rec.rating).toBe("good");
    const all = await listFeedback();
    expect(all.some((f) => f.question === "inttest q")).toBe(true);
  });
});
