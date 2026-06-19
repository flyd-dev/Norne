/**
 * End-to-end agent path: runAgentTurn drives the loop with a SCRIPTED model
 * (no live OpenAI) over mocked data sources, confirming the model's tool calls
 * execute against the real agent tools and the answer + sources + diagnostics
 * come back shaped as a ChatResult.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredStructuredTable } from "@/lib/documents/types";

const store = vi.hoisted(() => ({ tables: [] as StoredStructuredTable[] }));
vi.mock("@/lib/documents/store", () => ({ getStructuredTables: async () => store.tables }));
vi.mock("@/lib/firestore/service", async (orig) => {
  const actual = await orig<typeof import("@/lib/firestore/service")>();
  return { ...actual, getProjects: vi.fn(async () => []), getAccounts: vi.fn(async () => []) };
});
vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async () => [],
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));
vi.mock("@/lib/endre/client", () => ({ getEndreClient: () => null }));

import { runAgentTurn } from "@/lib/assistant/agent/run";
import type { AgentModel } from "@/lib/assistant/agent/loop";

function monthTable(month: string): StoredStructuredTable {
  const r = (role: "Steel fixer" | "Carpenter" | "Welder", h: number) => ({
    month, role, rawRole: role, availableHours: h, assignedHours: null, person: null,
  });
  return {
    documentId: "D1",
    documentName: "bemanningsplan_ai_demo_betong_2026.xlsx",
    sheetName: "Kapasitetsanalyse",
    columns: {},
    rows: [r("Steel fixer", 31.5), r("Carpenter", 57.8), r("Welder", 15.8)],
  };
}

/** Model that calls get_monthly_capacity once, then answers. */
function scriptedModel(): AgentModel {
  let step = 0;
  return {
    step: async () => {
      step += 1;
      if (step === 1) {
        return { toolCalls: [{ id: "c1", name: "get_monthly_capacity", args: { until_month: "2026-09" } }] };
      }
      return { content: "September 2026: Steel fixer 31.5 timer (kilde: Kapasitetsanalyse)." };
    },
  };
}

beforeEach(() => {
  store.tables = [monthTable("2026-07"), monthTable("2026-08"), monthTable("2026-09"), monthTable("2026-10")];
});

describe("runAgentTurn (scripted model)", () => {
  it("executes the tool call and returns a ChatResult with sources + diagnostics", async () => {
    const r = await runAgentTurn("Vis kapasitet frem til september 2026", "req", [], scriptedModel());
    expect(r.route).toBe("agent");
    expect(r.answer).toContain("September 2026");
    // The capacity tool ran and its source was collected for citation.
    expect(r.diagnostics?.toolsRun).toEqual([{ tool: "get_monthly_capacity", coverage: "ok" }]);
    expect(r.sources.join()).toContain("bemanningsplan_ai_demo_betong_2026.xlsx");
  });

  it("a model that answers immediately needs no tools", async () => {
    const model: AgentModel = { step: async () => ({ content: "Hei!" }) };
    const r = await runAgentTurn("hei", "req", [], model);
    expect(r.answer).toBe("Hei!");
    expect(r.diagnostics?.toolsRun ?? []).toEqual([]);
  });
});
