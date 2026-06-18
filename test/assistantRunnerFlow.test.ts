/**
 * End-to-end flow tests for the tool spine: planner selects tools (source policy
 * enforced), the runner dispatches them through the real registry against a
 * ToolContext, and coverage drives the outcome.
 *
 * Realistic flows (plan points 5–7):
 *   - capacity "frem til september 2026" → getMonthlyCapacity, full, incl. Sept
 *   - project metric without a contract-value field → partial, honest
 *   - vague opening question, no context → clarify, no random fetch
 *   - source policy: a project plan never selects capacity/account tools
 */

import { describe, expect, it } from "vitest";
import { buildRegistry } from "@/lib/assistant/tools/index";
import { selectTools } from "@/lib/assistant/planner";
import { runToolPlan, turnCoverage, collectSources } from "@/lib/assistant/runner";
import { parseMonthRange } from "@/lib/chat/dateRange";
import type { QuestionPlan } from "@/lib/chat/questionPlanner";
import type { ChatState } from "@/lib/assistant/state/chatState";
import type { ToolContext } from "@/lib/assistant/tools/registry";
import type { StoredStructuredTable } from "@/lib/documents/types";

const registry = buildRegistry();

function plan(p: Partial<QuestionPlan>): QuestionPlan {
  return {
    intent: "general",
    entities: {},
    needsHistory: false,
    candidateSources: [],
    excludedSources: [],
    confidence: "high",
    ...p,
  };
}

function state(s: Partial<ChatState> = {}): ChatState {
  return {
    hasContext: true,
    lastTopic: null,
    currentProject: null,
    currentDocument: null,
    currentCapacityScope: null,
    pendingClarification: false,
    knownProjectFacts: [],
    lastToolResult: null,
    turnCount: 1,
    ...s,
  };
}

const noClarify = { required: false, reason: null };

const DOC = "bemanningsplan_ai_demo_betong_2026.xlsx";
function capacityCtx(): ToolContext {
  const months = ["juli 2026", "august 2026", "september 2026", "oktober 2026"];
  const tables: StoredStructuredTable[] = months.map((month) => ({
    documentId: "D1",
    documentName: DOC,
    sheetName: "Kapasitetsanalyse",
    columns: {},
    rows: [
      { month, role: "Steel fixer", rawRole: "Steel fixer", availableHours: 31.5, assignedHours: 20, person: null },
      { month, role: "Carpenter", rawRole: "Carpenter", availableHours: 57.8, assignedHours: 20, person: null },
      { month, role: "Welder", rawRole: "Welder", availableHours: 15.8, assignedHours: 20, person: null },
    ],
  }));
  return { getStructuredTables: async () => tables };
}

describe("flow: capacity 'frem til september 2026'", () => {
  it("selects only getMonthlyCapacity and returns September with values", async () => {
    const p = plan({ intent: "monthly_capacity", entities: { month: "september" } });
    const tp = selectTools(p, state(), noClarify);
    expect(tp.tools).toEqual(["getMonthlyCapacity"]);

    const runs = await runToolPlan(
      tp,
      { getMonthlyCapacity: { bound: parseMonthRange("frem til september 2026") } },
      registry,
      capacityCtx(),
    );
    expect(turnCoverage(runs)).toBe("full");
    const out = runs[0].result.data as { months: { month: string }[] };
    expect(out.months.map((m) => m.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(collectSources(runs).join()).toContain(DOC);
  });
});

describe("flow: project metric without a contract-value field", () => {
  it("is honest (partial), never fabricates", async () => {
    const p = plan({ intent: "project_metric", metric: "contract_value", confidence: "high" });
    const tp = selectTools(p, state({ currentProject: { projectNumber: "7100", projectName: null } }), noClarify);
    expect(tp.tools).toEqual(["getProjectMetric"]);

    const ctx: ToolContext = {
      projectRecord: { project_number: "7100", amounts: { totals: { accepted: 5 } } },
      projectRef: { projectNumber: "7100", projectName: null },
      projectSources: ["Endre API: projects"],
    };
    const runs = await runToolPlan(tp, { getProjectMetric: { metric: "contract_value" } }, registry, ctx);
    expect(turnCoverage(runs)).toBe("partial");
    expect(runs[0].result.note).toMatch(/ikke et eget kontraktsverdi-felt/i);
  });
});

describe("flow: source policy", () => {
  it("a project question never selects capacity or account tools", () => {
    const tp = selectTools(plan({ intent: "project_summary" }), state(), noClarify);
    expect(tp.tools).toEqual(["getProjectSummary"]);
    expect(tp.tools).not.toContain("getMonthlyCapacity");
    expect(tp.tools).not.toContain("searchChartOfAccounts");
  });

  it("a capacity question never selects project or account tools", () => {
    const tp = selectTools(plan({ intent: "staffing_capacity" }), state(), noClarify);
    expect(tp.tools).toEqual(["getAvailableCapacity"]);
  });
});

describe("flow: clarification gate", () => {
  it("clarifies (no fetch) when required", () => {
    const tp = selectTools(plan({ intent: "project_metric" }), state(), {
      required: true,
      reason: "vague_metric_no_context",
    });
    expect(tp.clarify).toBe(true);
    expect(tp.tools).toEqual([]);
  });

  it("clarifies a general question in a chat with no context", () => {
    const tp = selectTools(plan({ intent: "general" }), state({ hasContext: false }), noClarify);
    expect(tp.clarify).toBe(true);
  });
});

describe("flow: low confidence advises an LLM tool-choice pass", () => {
  it("flags llmFallbackAdvised but still bounds tools by the source policy", () => {
    const tp = selectTools(plan({ intent: "project_metric", confidence: "low" }), state(), noClarify);
    expect(tp.llmFallbackAdvised).toBe(true);
    expect(tp.tools).toEqual(["getProjectMetric"]);
  });
});
