import { describe, expect, it } from "vitest";
import { validateToolRuns } from "@/lib/assistant/validate";
import type { ToolRun } from "@/lib/assistant/runner";
import type { QuestionPlan } from "@/lib/chat/questionPlanner";

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
const run = (tool: string, coverage: "full" | "partial" | "none", data: unknown = {}): ToolRun =>
  ({ tool, result: { data, sources: [], coverage } } as ToolRun);

describe("validateToolRuns", () => {
  it("no tools (clarify/general) is valid", () => {
    expect(validateToolRuns(plan({}), [])).toEqual({ ok: true, reason: "no_tools" });
  });

  it("full coverage is answerable", () => {
    const r = validateToolRuns(plan({ intent: "monthly_capacity" }), [run("getMonthlyCapacity", "full")]);
    expect(r).toEqual({ ok: true, reason: "answerable" });
  });

  it("partial coverage is answerable-but-incomplete (honest)", () => {
    const r = validateToolRuns(
      plan({ intent: "project_metric", metric: "contract_value" }),
      [run("getProjectMetric", "partial", { metric: "contract_value", value: null })],
    );
    expect(r).toEqual({ ok: true, reason: "incomplete" });
  });

  it("none coverage is not answerable", () => {
    const r = validateToolRuns(plan({ intent: "monthly_capacity" }), [run("getMonthlyCapacity", "none", null)]);
    expect(r).toEqual({ ok: false, reason: "no_data" });
  });

  it("flags a metric mismatch", () => {
    const r = validateToolRuns(
      plan({ intent: "project_metric", metric: "contract_value" }),
      [run("getProjectMetric", "full", { metric: "result", value: 5 })],
    );
    expect(r).toEqual({ ok: false, reason: "metric_mismatch" });
  });
});
