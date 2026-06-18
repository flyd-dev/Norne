/**
 * Regression tests for clarification CONTINUATION (the spec's headline flow).
 *
 * New chat:
 *   1. User: "Gi meg det du har frem til september 2026"  → clarification.
 *   2. User: "bemanning/kapasitet"                         → must:
 *        - inherit the original time range ("frem til september 2026"),
 *        - route to monthly_capacity,
 *        - list available capacity per month up to AND including September,
 *        - NOT produce a "Behov per fag: 0" / "Differanse: 0" demand analysis,
 *        - NOT conclude "ja, dere har kapasitet" (there is no demand),
 *        - NOT touch projects / accounts / Endre,
 *        - say monthly capacity is MISSING (never zeros) when there is none.
 *
 * runChat is exercised with Firestore, the LLM, document search, the Endre client
 * and the structured-table store mocked, so the assertions pin the app's
 * deterministic reasoning rather than the model's wording.
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
import { CLARIFICATION_QUESTION } from "@/lib/chat/clarify";

const mAccounts = vi.mocked(getAccounts);
const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

/** One available-hours row for a month (Carpenter, as in the demo plan). */
function monthRow(month: string, hours: number): StoredStructuredTable {
  return {
    documentId: "D1",
    documentName: "bemanningsplan.xlsx",
    sheetName: "Kapasitet",
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

/** The two turns the assistant has seen by the time the answer arrives. */
const CLARIFY_HISTORY = [
  { role: "user" as const, content: "Gi meg det du har frem til september 2026" },
  { role: "assistant" as const, content: CLARIFICATION_QUESTION },
];

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  cap.reply = "Et svar fra modellen.";
  mAccounts.mockResolvedValue([]);
  mProjects.mockResolvedValue([
    { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
  ]);
  mGetEndreClient.mockReturnValue(null);
  store.tables = [
    monthRow("januar 2026", 100),
    monthRow("august 2026", 200),
    monthRow("september 2026", 300),
    monthRow("oktober 2026", 400),
    monthRow("november 2026", 500),
    monthRow("desember 2026", 600),
  ];
});

describe("clarification continuation — period inherited, monthly_capacity", () => {
  it("step 1: the vague period opener clarifies without touching data", async () => {
    const r = await runChat(
      "Gi meg det du har frem til september 2026",
      "req",
      [],
    );
    expect(r.route).toBe("clarification");
    expect(r.answer).toBe(CLARIFICATION_QUESTION);
    expect(mProjects).not.toHaveBeenCalled();
    expect(mAccounts).not.toHaveBeenCalled();
    expect(cap.inputs).toHaveLength(0);
  });

  it("step 2: 'bemanning/kapasitet' routes to monthly_capacity through September", async () => {
    const r = await runChat("bemanning/kapasitet", "req", CLARIFY_HISTORY);

    expect(r.route).toBe("monthly_capacity");

    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // The inherited range is honoured: months up to and including September only.
    expect(userPrompt).toContain("august 2026");
    expect(userPrompt).toContain("september 2026");
    expect(userPrompt).not.toContain("oktober 2026");
    expect(userPrompt).not.toContain("november 2026");
    expect(userPrompt).not.toContain("desember 2026");
    expect(userPrompt).toContain("monthly_capacity");
  });

  it("step 2: no demand analysis is fabricated (no 0-need, no 0-difference)", async () => {
    await runChat("bemanning/kapasitet", "req", CLARIFY_HISTORY);
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // The deterministic artefacts of a demand analysis must be absent. (The
    // phrases «Behov per fag» / «Differanse» legitimately appear in the route's
    // guardrail instruction telling the model NOT to fabricate them, so we assert
    // on the structured context block and the rendered 0-lines instead.)
    expect(userPrompt).not.toContain("capacity_demand");
    expect(userPrompt).not.toMatch(/Behov per fag:\s*\n/i);
    expect(userPrompt).not.toMatch(/Differanse \(/i);
    expect(userPrompt).not.toMatch(/:\s*0%\s*=\s*0 timer/i);
  });

  it("step 2: does not touch projects, accounts or Endre, and invents no project", async () => {
    const r = await runChat("bemanning/kapasitet", "req", CLARIFY_HISTORY);
    expect(mProjects).not.toHaveBeenCalled();
    expect(mAccounts).not.toHaveBeenCalled();
    expect(mGetEndreClient).not.toHaveBeenCalled();
    expect(r.sources).not.toContain("accounts");
    expect(r.sources).not.toContain("projects");
    expect(r.diagnostics?.resolvedProjectNumber).toBeNull();
    // The year must never be read as "prosjekt 2026".
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).not.toMatch(/prosjekt 2026/i);
  });

  it("step 2: cites the bemanningsplan it answered from", async () => {
    const r = await runChat("bemanning/kapasitet", "req", CLARIFY_HISTORY);
    expect(r.sources).toContain("bemanningsplan.xlsx");
  });

  it("step 2: marks context as used (it inherited the original period)", async () => {
    const r = await runChat("bemanning/kapasitet", "req", CLARIFY_HISTORY);
    expect(r.diagnostics?.contextUsed).toBe(true);
  });
});

describe("clarification continuation — missing monthly data is stated, never zeroed", () => {
  it("says monthly capacity is missing instead of substituting zeros", async () => {
    store.tables = []; // no structured staffing rows at all
    const r = await runChat("bemanning/kapasitet", "req", CLARIFY_HISTORY);

    expect(r.route).toBe("monthly_capacity");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // The note must steer to "missing", not to fabricated numbers.
    expect(userPrompt).toMatch(/m(å|a)nedlig kapasitet.*mangler|mangler.*per m(å|a)ned/i);
    expect(userPrompt).not.toContain("capacity_demand");
    expect(userPrompt).not.toContain("monthly_capacity\":"); // no per-month block
    expect(userPrompt).not.toMatch(/Behov per fag:\s*\n/i);
  });
});

describe("clarification continuation — capacity answer with a different topic word", () => {
  it("'kapasitet' alone still inherits the period and routes monthly", async () => {
    const r = await runChat("kapasitet", "req", CLARIFY_HISTORY);
    expect(r.route).toBe("monthly_capacity");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).toContain("september 2026");
    expect(userPrompt).not.toContain("oktober 2026");
  });
});
