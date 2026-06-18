import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredChunk } from "@/lib/documents/types";

const store = vi.hoisted(() => ({ chunks: [] as StoredChunk[] }));

vi.mock("@/lib/documents/store", () => ({
  getAllChunks: async () => store.chunks,
}));

import { searchDocuments } from "@/lib/rag/documentSearch";

function chunk(partial: Partial<StoredChunk>): StoredChunk {
  return {
    documentId: "d1",
    documentName: "doc.txt",
    fileType: "txt",
    chunkIndex: 0,
    text: "",
    ...partial,
  };
}

beforeEach(() => {
  store.chunks = [];
});

describe("searchDocuments", () => {
  it("returns no matches when there are no chunks", async () => {
    expect(await searchDocuments("bemanning")).toEqual([]);
  });

  it("returns relevant chunks ranked by term frequency", async () => {
    store.chunks = [
      chunk({ chunkIndex: 0, text: "Dette handler om betong og armering." }),
      chunk({
        chunkIndex: 1,
        documentName: "bemanningsplan.xlsx",
        text: "Bemanning uke 12: Kari og Ola. Bemanning uke 13: Per.",
      }),
      chunk({ chunkIndex: 2, text: "Generell tekst uten relevans." }),
    ];

    const results = await searchDocuments("Hvem er på bemanning?");
    expect(results.length).toBeGreaterThan(0);
    // The bemanning chunk should rank first (term frequency + name boost).
    expect(results[0].chunkIndex).toBe(1);
    expect(results[0].documentName).toBe("bemanningsplan.xlsx");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("respects the result limit", async () => {
    store.chunks = Array.from({ length: 20 }, (_, i) =>
      chunk({ chunkIndex: i, text: "betong betong betong" }),
    );
    const results = await searchDocuments("betong", 5);
    expect(results.length).toBe(5);
  });

  it("ignores stopword-only queries", async () => {
    store.chunks = [chunk({ text: "noe innhold" })];
    expect(await searchDocuments("hva er det")).toEqual([]);
  });

  it("boosts the named staffing document and excludes the chart of accounts", async () => {
    store.chunks = [
      chunk({
        chunkIndex: 0,
        documentName: "Nornebygg - kontoplan - chart of accounts.xlsx",
        text: "Welder konto 5000 timer",
      }),
      chunk({
        chunkIndex: 1,
        documentName: "bemanningsplan_ai_demo_betong_2026.xlsx",
        sheetName: "Rotasjonsplan",
        text: "Welder tilgjengelig 9000 timer i august",
      }),
    ];
    const results = await searchDocuments("kapasitet welder august timer", {
      boostDocumentNames: ["bemanning"],
      boostSheetNames: ["rotasjonsplan"],
      boostTerms: ["welder", "august"],
      excludeDocumentNames: ["kontoplan", "chart of accounts"],
    });
    expect(results.length).toBe(1);
    expect(results[0].documentName).toBe("bemanningsplan_ai_demo_betong_2026.xlsx");
  });

  it("still accepts a numeric limit as the second argument", async () => {
    store.chunks = Array.from({ length: 20 }, (_, i) =>
      chunk({ chunkIndex: i, text: "betong betong" }),
    );
    expect((await searchDocuments("betong", 3)).length).toBe(3);
  });
});
