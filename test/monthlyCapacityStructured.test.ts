/**
 * Regression: "Vis tilgjengelig kapasitet per fag frem til september 2026" must
 * surface the per-fag monthly capacity from bemanningsplan_ai_demo_betong_2026
 * .xlsx / Kapasitetsanalyse — and must NOT claim the data is missing.
 *
 * Two paths are pinned, because the real workbook can land in either:
 *
 *  1. STRUCTURED path — Kapasitetsanalyse parsed into month-bearing rows. The
 *     monthly context must carry juli/august/september 2026 with the per-fag
 *     values (Steel fixer 31.5, Carpenter 57.8, Welder 15.8), exclude
 *     oktober–desember, and the month-less Dashboard totals must NOT replace or
 *     pollute the structured monthly breakdown.
 *
 *  2. DOCUMENT-FALLBACK path — no structured monthly rows (only a Dashboard
 *     totals table), but the Kapasitetsanalyse sheet is present as document text
 *     chunks. The model must be told to read the per-fag monthly figures from
 *     those chunks, NOT that monthly capacity is missing.
 *
 * runChat is exercised with Firestore, the LLM, document search, the Endre
 * client and the structured-table store mocked, so the assertions pin the app's
 * deterministic reasoning (the context + guardrail notes it hands the model).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredStructuredTable } from "@/lib/documents/types";
import type { DocumentMatch } from "@/lib/rag/documentSearch";

vi.mock("@/lib/firestore/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firestore/service")>();
  return {
    ...actual,
    getAccounts: vi.fn(),
    getProjects: vi.fn(),
    getBudgetLines: vi.fn(),
    getQuantities: vi.fn(),
  };
});

const cap = vi.hoisted(() => ({
  inputs: [] as { systemPrompt: string; userPrompt: string }[],
  reply: "Et svar fra modellen.",
}));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "test",
    generateAnswer: async (input: { systemPrompt: string; userPrompt: string }) => {
      cap.inputs.push(input);
      return cap.reply;
    },
  }),
}));

const search = vi.hoisted(() => ({ matches: [] as unknown[] }));
vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async () => search.matches,
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));

vi.mock("@/lib/endre/client", () => ({ getEndreClient: vi.fn() }));

const store = vi.hoisted(() => ({ tables: [] as StoredStructuredTable[] }));
vi.mock("@/lib/documents/store", () => ({
  getStructuredTables: async () => store.tables,
}));

import { runChat } from "@/lib/chat/orchestrator";
import { getAccounts, getProjects } from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";

const mAccounts = vi.mocked(getAccounts);
const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

const DOC = "bemanningsplan_ai_demo_betong_2026.xlsx";
const QUESTION = "Vis tilgjengelig kapasitet per fag frem til september 2026";

/** Per-fag monthly availability for one month, as in the demo plan. */
function monthRows(month: string): StoredStructuredTable {
  const role = (
    r: "Steel fixer" | "Carpenter" | "Welder",
    hours: number,
  ) => ({ month, role: r, rawRole: r, availableHours: hours, assignedHours: null, person: null });
  return {
    documentId: "D1",
    documentName: DOC,
    sheetName: "Kapasitetsanalyse",
    columns: {},
    rows: [role("Steel fixer", 31.5), role("Carpenter", 57.8), role("Welder", 15.8)],
  };
}

/** A month-less "Dashboard" totals table (must never drive the monthly view). */
function dashboardTotals(): StoredStructuredTable {
  const role = (r: "Steel fixer" | "Carpenter" | "Welder", hours: number) => ({
    month: null,
    role: r,
    rawRole: r,
    availableHours: hours,
    assignedHours: null,
    person: null,
  });
  return {
    documentId: "D1",
    documentName: DOC,
    sheetName: "Dashboard",
    columns: {},
    rows: [role("Steel fixer", 94.5), role("Carpenter", 173.4), role("Welder", 47.4)],
  };
}

/** A Kapasitetsanalyse text chunk carrying the per-fag monthly figures. */
function kapasitetChunk(): DocumentMatch {
  return {
    documentId: "D1",
    documentName: DOC,
    fileType: "xlsx",
    sheetName: "Kapasitetsanalyse",
    chunkIndex: 0,
    score: 1,
    text: [
      "Ark: Kapasitetsanalyse",
      "Juli 2026: Steel fixer 31.5, Carpenter 57.8, Welder 15.8",
      "August 2026: Steel fixer 31.5, Carpenter 57.8, Welder 15.8",
      "September 2026: Steel fixer 31.5, Carpenter 57.8, Welder 15.8",
      "Oktober 2026: Steel fixer 31.5, Carpenter 57.8, Welder 15.8",
    ].join("\n"),
  } as DocumentMatch;
}

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  cap.reply = "Et svar fra modellen.";
  search.matches = [];
  store.tables = [];
  mAccounts.mockResolvedValue([]);
  mProjects.mockResolvedValue([
    { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
  ]);
  mGetEndreClient.mockReturnValue(null);
});

describe("monthly capacity — structured Kapasitetsanalyse with Dashboard totals", () => {
  beforeEach(() => {
    // Dashboard totals FIRST, so a naive read would let them mask the monthly
    // breakdown; the orchestrator must still prefer the month-bearing rows.
    store.tables = [
      dashboardTotals(),
      monthRows("juli 2026"),
      monthRows("august 2026"),
      monthRows("september 2026"),
      monthRows("oktober 2026"),
      monthRows("november 2026"),
      monthRows("desember 2026"),
    ];
  });

  it("routes monthly and surfaces juli/august/september per-fag values", async () => {
    const r = await runChat(QUESTION, "req", []);
    expect(r.route).toBe("monthly_capacity");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    for (const m of ["juli 2026", "august 2026", "september 2026"]) {
      expect(userPrompt).toContain(m);
    }
    // Per-fag values are present in the structured monthly context.
    expect(userPrompt).toContain("31.5");
    expect(userPrompt).toContain("57.8");
    expect(userPrompt).toContain("15.8");
  });

  it("excludes oktober/november/desember and never claims missing", async () => {
    await runChat(QUESTION, "req", []);
    const userPrompt = cap.inputs.at(-1)!.userPrompt.toLowerCase();
    expect(userPrompt).not.toContain("oktober 2026");
    expect(userPrompt).not.toContain("november 2026");
    expect(userPrompt).not.toContain("desember 2026");
    // The "monthly capacity is missing" guardrail must NOT be present.
    expect(userPrompt).not.toContain("tilgjengelig kapasitet per måned mangler");
  });

  it("does not let Dashboard totals replace the monthly breakdown", async () => {
    await runChat(QUESTION, "req", []);
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // The Dashboard totals (94.5 / 173.4 / 47.4) must not appear as the answer.
    expect(userPrompt).not.toContain("94.5");
    expect(userPrompt).not.toContain("173.4");
    expect(userPrompt).not.toContain("47.4");
  });

  it("cites the bemanningsplan it answered from", async () => {
    const r = await runChat(QUESTION, "req", []);
    expect(r.sources).toContain(DOC);
  });
});

describe("monthly capacity — document fallback when no structured monthly rows", () => {
  beforeEach(() => {
    // Only a month-less Dashboard totals table is structured; the monthly figures
    // live in the Kapasitetsanalyse TEXT chunk.
    store.tables = [dashboardTotals()];
    search.matches = [kapasitetChunk()];
  });

  it("tells the model to read monthly figures from the document chunks", async () => {
    const r = await runChat(QUESTION, "req", []);
    expect(r.route).toBe("monthly_capacity");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // The Kapasitetsanalyse chunk (with per-fag monthly values) is in context.
    expect(userPrompt).toContain("Kapasitetsanalyse");
    expect(userPrompt).toContain("31.5");
    // The guardrail must point at the document chunks, NOT claim the data is
    // missing for the whole period.
    expect(userPrompt).toMatch(/Kapasitetsanalyse[^]*per fag per måned|per fag per måned/);
    expect(userPrompt.toLowerCase()).not.toContain(
      "tilgjengelig kapasitet per måned mangler",
    );
  });

  it("still scrubs out-of-period months from the final answer", async () => {
    cap.reply = [
      "Tilgjengelig kapasitet per fag frem til september 2026:",
      "- Juli 2026: Steel fixer 31.5, Carpenter 57.8, Welder 15.8",
      "- August 2026: Steel fixer 31.5, Carpenter 57.8, Welder 15.8",
      "- September 2026: Steel fixer 31.5, Carpenter 57.8, Welder 15.8",
      "Måneder utenfor perioden: oktober 2026.",
      `Kilde: ${DOC} (Kapasitetsanalyse).`,
    ].join("\n");
    const r = await runChat(QUESTION, "req", []);
    expect(r.answer).toContain("Juli 2026");
    expect(r.answer).toContain("September 2026");
    expect(r.answer).toContain("31.5");
    expect(r.answer.toLowerCase()).not.toContain("oktober");
    expect(r.sources).toContain(DOC);
  });

  it("only claims missing when there is nothing to read at all", async () => {
    search.matches = [];
    store.tables = [];
    await runChat(QUESTION, "req", []);
    const userPrompt = cap.inputs.at(-1)!.userPrompt.toLowerCase();
    expect(userPrompt).toContain("tilgjengelig kapasitet per måned mangler");
  });
});

/**
 * Live-shaped regression: the real Kapasitetsanalyse sheet lands as row-style
 * TEXT ("Måned: september 2026 | Fag: Stålfikser | Tilgjengelig: 31,5 | …"),
 * NOT as parsed structured rows. The previous build handed these chunks to the
 * model with only a "read them" note, and the model dropped the last in-range
 * month — September said "Tall for tilgjengelig kapasitet er ikke oppgitt".
 *
 * The orchestrator must now read the per-fag monthly figures deterministically
 * from this text, INCLUDE September (inclusive "frem til"), exclude oktober–
 * desember, and never tell the model September is missing.
 */
function kapasitetRowChunk(): DocumentMatch {
  // One row per (month, fag): month | fag | tilgjengelig | tildelt | navn.
  // Norwegian fag names + comma decimals, exactly as the workbook exports.
  const row = (month: string, fag: string, avail: string) =>
    `Måned: ${month} | Fag: ${fag} | Tilgjengelig: ${avail} | Tildelt: 20 | Navn: Per`;
  const months = [
    "juli 2026",
    "august 2026",
    "september 2026",
    "oktober 2026",
    "november 2026",
    "desember 2026",
  ];
  const lines = ["Ark: Kapasitetsanalyse", "Kolonner: Måned, Fag, Tilgjengelig, Tildelt, Navn"];
  for (const m of months) {
    lines.push(row(m, "Stålfikser", "31,5"));
    lines.push(row(m, "Tømrer", "57,8"));
    lines.push(row(m, "Sveiser", "15,8"));
  }
  return {
    documentId: "D1",
    documentName: DOC,
    fileType: "xlsx",
    sheetName: "Kapasitetsanalyse",
    chunkIndex: 0,
    score: 1,
    text: lines.join("\n"),
  } as DocumentMatch;
}

describe("monthly capacity — row-style Kapasitetsanalyse text (live shape)", () => {
  beforeEach(() => {
    // No structured monthly rows — only the row-style text chunk exists.
    store.tables = [];
    search.matches = [kapasitetRowChunk()];
  });

  it("surfaces July/August/September per-fag values deterministically", async () => {
    const r = await runChat(QUESTION, "req", []);
    expect(r.route).toBe("monthly_capacity");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // Each in-range month must carry all three fag with their exact values.
    for (const month of ["juli 2026", "august 2026", "september 2026"]) {
      const line = userPrompt
        .split("\n")
        .find((l) => l.toLowerCase().includes(`- ${month}`));
      expect(line, `deterministic line for ${month}`).toBeTruthy();
      expect(line).toContain("Steel fixer 31.5 timer");
      expect(line).toContain("Carpenter 57.8 timer");
      expect(line).toContain("Welder 15.8 timer");
    }
  });

  it("never tells the model September is missing, and excludes okt–des", async () => {
    await runChat(QUESTION, "req", []);
    const lower = cap.inputs.at(-1)!.userPrompt.toLowerCase();
    expect(lower).not.toContain("tilgjengelig kapasitet per måned mangler");
    // The deterministic note lists no out-of-period month.
    const noteStart = lower.indexOf("tilgjengelig kapasitet per fag per måned");
    const note = lower.slice(noteStart);
    expect(note).not.toContain("- oktober 2026");
    expect(note).not.toContain("- november 2026");
    expect(note).not.toContain("- desember 2026");
  });

  it("cites the bemanningsplan/Kapasitetsanalyse it answered from", async () => {
    const r = await runChat(QUESTION, "req", []);
    expect(r.sources).toContain(DOC);
    expect(cap.inputs.at(-1)!.userPrompt).toContain("Kapasitetsanalyse");
  });

  it("keeps September in the final answer through the scrub", async () => {
    cap.reply = [
      "Tilgjengelig kapasitet per fag frem til september 2026:",
      "Juli 2026: Steel fixer 31.5 timer, Carpenter 57.8 timer, Welder 15.8 timer",
      "August 2026: Steel fixer 31.5 timer, Carpenter 57.8 timer, Welder 15.8 timer",
      "September 2026: Steel fixer 31.5 timer, Carpenter 57.8 timer, Welder 15.8 timer",
      `Kilde: ${DOC} (Kapasitetsanalyse).`,
    ].join("\n");
    const r = await runChat(QUESTION, "req", []);
    expect(r.answer).toContain("September 2026: Steel fixer 31.5 timer");
    expect(r.answer.toLowerCase()).not.toContain("ikke oppgitt");
    expect(r.answer.toLowerCase()).not.toContain("oktober");
  });
});
