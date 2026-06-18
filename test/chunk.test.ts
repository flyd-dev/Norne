import { describe, expect, it } from "vitest";
import { buildChunks, chunkText } from "@/lib/documents/chunk";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("kort tekst")).toEqual(["kort tekst"]);
  });

  it("returns nothing for empty/whitespace text", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits long text into overlapping chunks within the size bound", () => {
    const text = "abcdefghij ".repeat(400); // ~4400 chars
    const chunks = chunkText(text, { size: 1000, overlap: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
    }
  });

  it("creates overlap between consecutive chunks", () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(text, { size: 500, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0].slice(-40);
    // Some text from the end of chunk 0 should reappear in chunk 1.
    const overlapFound = tail
      .split(" ")
      .some((w) => w.length > 0 && chunks[1].includes(w));
    expect(overlapFound).toBe(true);
  });
});

describe("buildChunks", () => {
  it("assigns sequential chunkIndex and carries metadata + sheetName", () => {
    const chunks = buildChunks(
      {
        fileType: "xlsx",
        segments: [
          { sheetName: "Ark1", text: "a".repeat(1500) },
          { sheetName: "Ark2", text: "b".repeat(300) },
        ],
      },
      { documentId: "doc1", documentName: "plan.xlsx", uploadedAt: "2026-01-01T00:00:00Z" },
      { size: 1000, overlap: 200 },
    );

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // chunkIndex is sequential across segments.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(
      chunks.map((_, i) => i),
    );
    expect(chunks[0]).toMatchObject({
      documentId: "doc1",
      documentName: "plan.xlsx",
      fileType: "xlsx",
      sheetName: "Ark1",
      uploadedAt: "2026-01-01T00:00:00Z",
    });
    // The last chunk belongs to the second sheet.
    expect(chunks[chunks.length - 1].sheetName).toBe("Ark2");
  });

  it("uses null sheetName for non-spreadsheet files", () => {
    const chunks = buildChunks(
      { fileType: "txt", segments: [{ text: "hei verden" }] },
      { documentId: "d", documentName: "n.txt", uploadedAt: "t" },
    );
    expect(chunks[0].sheetName).toBeNull();
  });
});
