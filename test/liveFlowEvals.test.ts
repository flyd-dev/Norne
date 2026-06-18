/**
 * Multi-turn evals through the LIVE path (runChat), tying together the explicit
 * chat state, the tool layer and the guards (plan points 5–7, T4.10):
 *
 *   1. New chat, vague capacity opener        → clarification (no fetch)
 *   2. After a capacity turn, "frem til …"     → monthly_capacity via the tool
 *   3. "Oppsummer 7100" → "kontraktsverdien?"  → inherits project, value answered
 *   4. Project without a contract-value field  → honest (getProjectMetric partial)
 *
 * Firestore/LLM/search/Endre/store are mocked so the assertions pin the
 * deterministic behaviour, not model wording.
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

const cap = vi.hoisted(() => ({ inputs: [] as { systemPrompt: string; userPrompt: string }[], reply: "Et svar." }));
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
  cap.reply = "Et svar.";
  search.matches = [];
  store.tables = [];
  mAccounts.mockResolvedValue([]);
  mProjects.mockResolvedValue([]);
  mGetEndreClient.mockReturnValue(null);
});

describe("live flow", () => {
  it("1. new chat vague capacity opener → clarification, no fetch", async () => {
    const r = await runChat("Gi meg det du har frem til september 2026", "req", []);
    expect(r.route).toBe("clarification");
    expect(r.diagnostics?.clarificationRequired).toBe(true);
    // No project fetch happened for a vague opener.
    expect(mProjects).not.toHaveBeenCalled();
  });

  it("2. capacity follow-up routes monthly and runs the capacity tool", async () => {
    store.tables = [monthTable("juli 2026"), monthTable("august 2026"), monthTable("september 2026")];
    const history = [
      { role: "user" as const, content: "Vis tilgjengelig kapasitet frem til september 2026" },
      { role: "assistant" as const, content: "Juli/August/September …" },
    ];
    const r = await runChat("Gi meg det du har frem til september 2026", "req", history);
    expect(r.route).toBe("monthly_capacity");
    expect(r.diagnostics?.toolsRun).toEqual([{ tool: "getMonthlyCapacity", coverage: "full" }]);
    expect(r.diagnostics?.toolsPlanned).toEqual(["getMonthlyCapacity"]);
  });

  it("3. project summary then metric inherits the project and answers the value", async () => {
    mProjects.mockResolvedValue([
      { id: "F_7100", project_name: "Pilestredet", project_number: "7100", kontraktsverdi: 150705668 },
    ]);
    const history = [
      { role: "user" as const, content: "Oppsummer prosjekt 7100" },
      {
        role: "assistant" as const,
        content: "Prosjektnavn: Pilestredet\nProsjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
      },
    ];
    const r = await runChat("Hva er kontraktsverdien?", "req", history);
    // The project is inherited from the current chat (elliptical follow-up) …
    expect(r.diagnostics?.resolvedProjectNumber).toBe("7100");
    // … and the value is answered deterministically (not "mangler informasjon").
    expect(r.diagnostics?.deterministicAnswerUsed).toBe(true);
    expect(r.answer).toContain("150 705 668");
  });

  it("4. project without a contract-value field is honest (tool partial)", async () => {
    mProjects.mockResolvedValue([
      { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
    ]);
    const r = await runChat("Hva er kontraktsverdien på prosjekt 7100?", "req", []);
    expect(r.diagnostics?.toolsRun).toContainEqual({ tool: "getProjectMetric", coverage: "partial" });
  });
});

describe("LLM tool-choice flag (ASSISTANT_LLM_TOOL_CHOICE)", () => {
  it("off by default: capacity stays getMonthlyCapacity, no extra model call", async () => {
    store.tables = [monthTable("juli 2026")];
    const r = await runChat("Vis kapasitet frem til juli 2026", "req", []);
    expect(r.diagnostics?.toolsPlanned).toEqual(["getMonthlyCapacity"]);
    // Only the answer-generation call happened (no tool-choice call).
    expect(cap.inputs).toHaveLength(1);
  });

  it("on: a low-confidence capacity turn lets the model override within the family", async () => {
    vi.stubEnv("ASSISTANT_LLM_TOOL_CHOICE", "true");
    // The deterministic choice for "har vi nok folk totalt" is getAvailableCapacity;
    // the model overrides to the sibling getMonthlyCapacity (same capacity family).
    cap.reply = "getMonthlyCapacity";
    store.tables = [monthTable("juli 2026")];
    try {
      const r = await runChat("Har vi nok folk totalt?", "req", []);
      expect(r.diagnostics?.toolsPlanned).toEqual(["getMonthlyCapacity"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
