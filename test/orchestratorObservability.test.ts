/**
 * Observability + live ChatState (T1.2 + T4.11): the orchestrator records which
 * tools it dispatched (with coverage) and exposes the explicit chat-state focus
 * in diagnostics. Firestore/LLM/search/Endre/store are mocked so the assertions
 * pin the deterministic diagnostics, not model output.
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

const cap = vi.hoisted(() => ({ inputs: [] as { systemPrompt: string; userPrompt: string }[] }));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "test",
    generateAnswer: async (input: { systemPrompt: string; userPrompt: string }) => {
      cap.inputs.push(input);
      return "Et svar.";
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
vi.mock("@/lib/documents/store", () => ({ getStructuredTables: async () => store.tables }));

import { runChat } from "@/lib/chat/orchestrator";
import { getAccounts, getProjects } from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";

const mAccounts = vi.mocked(getAccounts);
const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

function monthTable(month: string): StoredStructuredTable {
  return {
    documentId: "D1",
    documentName: "bemanningsplan.xlsx",
    sheetName: "Kapasitetsanalyse",
    columns: {},
    rows: [
      { month, role: "Carpenter", rawRole: "Carpenter", availableHours: 100, assignedHours: null, person: null },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  search.matches = [];
  store.tables = [];
  mAccounts.mockResolvedValue([]);
  mProjects.mockResolvedValue([]);
  mGetEndreClient.mockReturnValue(null);
});

describe("observability — tools run with coverage", () => {
  it("records getMonthlyCapacity with full coverage for a capacity question", async () => {
    store.tables = [monthTable("juli 2026"), monthTable("august 2026")];
    const r = await runChat("Vis tilgjengelig kapasitet per fag frem til august 2026", "req", []);
    expect(r.diagnostics?.toolsRun).toEqual([
      { tool: "getMonthlyCapacity", coverage: "full" },
    ]);
  });

  it("records getAccountForPurchase coverage for an account lookup", async () => {
    mAccounts.mockResolvedValue([
      { id: "1", account_number: "6570", name: "Verneutstyr" },
    ]);
    const r = await runChat("Hva fører jeg arbeidshansker på?", "req", []);
    const runs = r.diagnostics?.toolsRun ?? [];
    expect(runs.some((t) => t.tool === "getAccountForPurchase")).toBe(true);
  });
});

describe("live ChatState — explicit project focus in diagnostics", () => {
  it("exposes the in-focus project number from chat state", async () => {
    mProjects.mockResolvedValue([
      { id: "F_7100", project_name: "Pilestredet", project_number: "7100", kontraktsverdi: 5 },
    ]);
    const history = [
      { role: "user" as const, content: "Oppsummer prosjekt 7100" },
      { role: "assistant" as const, content: "Prosjekt 7100 (Pilestredet) …" },
    ];
    const r = await runChat("Hva er kontraktsverdien?", "req", history);
    expect(r.diagnostics?.stateProject).toBe("7100");
  });

  it("flags capacity scope in state after a capacity turn", async () => {
    store.tables = [monthTable("juli 2026")];
    const history = [
      { role: "user" as const, content: "Vis kapasitet frem til september 2026" },
      { role: "assistant" as const, content: "Juli …" },
    ];
    const r = await runChat("Vis kapasitet frem til september 2026", "req", history);
    expect(r.diagnostics?.stateCapacityScope).toBe(true);
  });
});
