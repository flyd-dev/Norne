import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Mocks for generation -------------------------------------------------
const store = vi.hoisted(() => ({ chunks: [] as unknown[] }));
vi.mock("@/lib/documents/store", () => ({
  getAllChunks: async () => store.chunks,
}));

const llm = vi.hoisted(() => ({
  lastUserPrompt: "",
  reply: "## Parter\n- Nornebygg\n- Windport",
}));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "anthropic",
    generateAnswer: async (input: { userPrompt: string }) => {
      llm.lastUserPrompt = input.userPrompt;
      return llm.reply;
    },
  }),
}));

import { readDossier, writeDossier } from "@/lib/dossier/store";
import { generateDossier } from "@/lib/dossier/generate";

let dir: string;

function chunk(documentId: string, documentName: string, chunkIndex: number, text: string) {
  return { documentId, documentName, fileType: "pdf", chunkIndex, text };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "norne-dossier-"));
  process.env.DOSSIER_PATH = join(dir, "case-dossier.json");
  store.chunks = [];
  llm.lastUserPrompt = "";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dossier store", () => {
  it("round-trips a dossier", async () => {
    expect(await readDossier()).toBeNull();
    await writeDossier({
      generatedAt: "2026-06-23T00:00:00.000Z",
      documentCount: 3,
      text: "## Status\n- Pågår",
    });
    const back = await readDossier();
    expect(back?.documentCount).toBe(3);
    expect(back?.text).toContain("Pågår");
  });
});

describe("generateDossier", () => {
  it("synthesises a dossier from all documents and persists it", async () => {
    store.chunks = [
      chunk("d1", "Avtale med Windport Signert.pdf", 1, "andre del"),
      chunk("d1", "Avtale med Windport Signert.pdf", 0, "Avtaletekst første del"),
      chunk("d2", "20231122 møte med Vattenfall.pdf", 0, "Referat fra møtet"),
    ];

    const dossier = await generateDossier();
    expect(dossier).not.toBeNull();
    expect(dossier?.documentCount).toBe(2); // two distinct documents
    expect(dossier?.text).toContain("Parter");

    // Input includes both document names, and chunks are ordered by index.
    expect(llm.lastUserPrompt).toContain("Avtale med Windport Signert.pdf");
    expect(llm.lastUserPrompt).toContain("20231122 møte med Vattenfall.pdf");
    expect(llm.lastUserPrompt.indexOf("Avtaletekst første del")).toBeLessThan(
      llm.lastUserPrompt.indexOf("andre del"),
    );

    // Persisted and readable back.
    const back = await readDossier();
    expect(back?.text).toBe(llm.reply);
  });

  it("returns null when there are no documents", async () => {
    store.chunks = [];
    expect(await generateDossier()).toBeNull();
  });
});
