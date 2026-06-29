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
  lastMaxTokens: undefined as number | undefined,
  lastModel: undefined as string | undefined,
  truncate: false,
  reply: "## Parter\n- Nornebygg\n- Windport",
}));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "anthropic",
    generateAnswer: async (input: {
      userPrompt: string;
      maxTokens?: number;
      model?: string;
      onTruncated?: () => void;
    }) => {
      llm.lastUserPrompt = input.userPrompt;
      llm.lastMaxTokens = input.maxTokens;
      llm.lastModel = input.model;
      if (llm.truncate) input.onTruncated?.();
      return llm.reply;
    },
  }),
}));

import { readDossier, writeDossier } from "@/lib/dossier/store";
import { generateDossier, selectExcerpt } from "@/lib/dossier/generate";

let dir: string;

function chunk(documentId: string, documentName: string, chunkIndex: number, text: string) {
  return { documentId, documentName, fileType: "pdf", chunkIndex, text };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "norne-dossier-"));
  process.env.DOSSIER_PATH = join(dir, "case-dossier.json");
  store.chunks = [];
  llm.lastUserPrompt = "";
  llm.lastMaxTokens = undefined;
  llm.lastModel = undefined;
  llm.truncate = false;
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

  it("synthesises on a top-tier model with a raised output cap", async () => {
    store.chunks = [chunk("d1", "Avtale.pdf", 0, "tekst")];
    await generateDossier();
    // Output cap is well above the ~4k chat default so a long dossier isn't cut.
    expect(llm.lastMaxTokens ?? 0).toBeGreaterThanOrEqual(16_000);
    // Anthropic default for the dossier is Opus (chat default is Sonnet).
    expect(llm.lastModel).toBe("claude-opus-4-8");
  });

  it("flags and persists a truncated dossier", async () => {
    store.chunks = [chunk("d1", "Avtale.pdf", 0, "tekst")];
    llm.truncate = true;
    const dossier = await generateDossier();
    expect(dossier?.truncated).toBe(true);
    expect((await readDossier())?.truncated).toBe(true);
  });
});

describe("selectExcerpt", () => {
  it("returns the whole document in chunk order when it fits", () => {
    const out = selectExcerpt(
      [
        { i: 1, text: "andre" },
        { i: 0, text: "første" },
      ],
      1000,
    );
    expect(out).toBe("første\nandre");
  });

  it("samples across the whole document (not just the start) when over budget", () => {
    // 10 chunks of 100 chars (each tagged with its index digit); a 300-char
    // budget would, with a leading slice, only ever reach chunks 0–2.
    const chunks = Array.from({ length: 10 }, (_, i) => ({ i, text: `${i}`.padEnd(100, "x") }));
    const out = selectExcerpt(chunks, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("…"); // gap marker → spread path, not a contiguous slice
    // It reached a chunk beyond the opening 0–2 (a leading slice never would).
    expect(/[3-9]/.test(out)).toBe(true);
  });
});
