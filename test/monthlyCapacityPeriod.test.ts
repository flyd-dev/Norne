/**
 * Regression: monthly-capacity period wording must stay inside the requested
 * range.
 *
 * For "Vis tilgjengelig kapasitet per fag frem til september 2026" the answer
 * must:
 *   - list the months that fall inside the range (juli/august/september 2026),
 *   - never expose or mention months OUTSIDE the range (oktober/november/
 *     desember 2026) — not as data and not as "missing",
 *   - never instruct the model to describe excluded months as missing, and
 *   - still cite the bemanningsplan/Kapasitetsanalyse it answered from.
 *
 * runChat is exercised with Firestore, the LLM, document search, the Endre
 * client and the structured-table store mocked, so the assertions pin the app's
 * deterministic reasoning (the context + guardrail notes it hands the model),
 * not the model's wording.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredStructuredTable } from "@/lib/documents/types";

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

vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async () => [],
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));

vi.mock("@/lib/endre/client", () => ({ getEndreClient: vi.fn() }));

const store = vi.hoisted(() => ({
  tables: [] as StoredStructuredTable[],
}));
vi.mock("@/lib/documents/store", () => ({
  getStructuredTables: async () => store.tables,
}));

import { runChat } from "@/lib/chat/orchestrator";
import { getAccounts, getProjects } from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";

const mAccounts = vi.mocked(getAccounts);
const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

/** One available-hours row for a month (Carpenter, as in the demo plan). */
function monthRow(month: string, hours: number): StoredStructuredTable {
  return {
    documentId: "D1",
    documentName: "bemanningsplan.xlsx",
    sheetName: "Kapasitetsanalyse",
    columns: {},
    rows: [
      {
        month,
        role: "Carpenter",
        rawRole: "Carpenter",
        availableHours: hours,
        assignedHours: null,
        person: null,
      },
    ],
  };
}

const QUESTION = "Vis tilgjengelig kapasitet per fag frem til september 2026";

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  cap.reply = "Et svar fra modellen.";
  mAccounts.mockResolvedValue([]);
  mProjects.mockResolvedValue([
    { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
  ]);
  mGetEndreClient.mockReturnValue(null);
  // The plan carries the full year; the answer must keep only juli–september.
  store.tables = [
    monthRow("juli 2026", 100),
    monthRow("august 2026", 200),
    monthRow("september 2026", 300),
    monthRow("oktober 2026", 400),
    monthRow("november 2026", 500),
    monthRow("desember 2026", 600),
  ];
});

describe("monthly capacity — 'frem til september 2026' period wording", () => {
  it("routes monthly and includes the months inside the period", async () => {
    const r = await runChat(QUESTION, "req", []);
    expect(r.route).toBe("monthly_capacity");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).toContain("juli 2026");
    expect(userPrompt).toContain("august 2026");
    expect(userPrompt).toContain("september 2026");
  });

  it("excludes October/November/December entirely", async () => {
    await runChat(QUESTION, "req", []);
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).not.toContain("oktober 2026");
    expect(userPrompt).not.toContain("november 2026");
    expect(userPrompt).not.toContain("desember 2026");
  });

  it("never tells the model that excluded months are missing", async () => {
    await runChat(QUESTION, "req", []);
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // The guardrail must scope "missing" to within the period and explicitly
    // forbid describing months outside the period as missing.
    expect(userPrompt).toMatch(/INNENFOR den etterspurte perioden/);
    expect(userPrompt).toMatch(/ikke omtal m(å|a)neder utenfor perioden som manglende|aldri m(å|a)neder utenfor perioden som manglende/i);
    // No excluded month may appear next to a "missing" word.
    for (const m of ["oktober", "november", "desember"]) {
      expect(userPrompt.toLowerCase()).not.toContain(`${m} 2026`);
    }
  });

  it("cites the bemanningsplan/Kapasitetsanalyse it answered from", async () => {
    const r = await runChat(QUESTION, "req", []);
    expect(r.sources).toContain("bemanningsplan.xlsx");
  });
});
