/**
 * Validation gate (plan flow-step G): before the model is allowed to phrase an
 * answer, confirm the tool results actually ANSWER the question.
 *
 * Coverage already tells us whether a tool found anything; this adds the
 * question-shaped check on top:
 *   - none      → not answerable (the runner should show what it has or ask)
 *   - partial   → answerable but incomplete/honest (e.g. no contract-value field)
 *   - full      → answerable; for a metric question the returned metric must match
 *
 * Pure and dependency-free. Returns a verdict + coded reason for diagnostics.
 */

import type { QuestionPlan } from "@/lib/chat/questionPlanner";
import type { ToolRun } from "@/lib/assistant/runner";
import type { ProjectMetricValue } from "@/lib/assistant/domain/project";

export interface ValidationResult {
  /** True when the turn can be answered from the tool data (full or honest-partial). */
  ok: boolean;
  /** Coded reason, for diagnostics: "answerable" | "incomplete" | "no_data" | … */
  reason: string;
}

/** The best (full > partial > none) coverage across the runs. */
function bestCoverage(runs: ToolRun[]): "full" | "partial" | "none" {
  let best: "full" | "partial" | "none" = "none";
  for (const run of runs) {
    if (run.result.coverage === "full") return "full";
    if (run.result.coverage === "partial") best = "partial";
  }
  return best;
}

/**
 * Validate the tool runs against the plan. A turn with no tools (a clarification
 * or a general answer) is considered valid here — clarification is decided
 * upstream. The check bites when tools ran but returned nothing usable, or when a
 * metric tool answered with a different metric than asked.
 */
export function validateToolRuns(
  plan: QuestionPlan,
  runs: ToolRun[],
): ValidationResult {
  if (runs.length === 0) {
    return { ok: true, reason: "no_tools" };
  }

  const coverage = bestCoverage(runs);
  if (coverage === "none") {
    return { ok: false, reason: "no_data" };
  }

  // Metric question: the full run must be for the metric that was asked.
  if (plan.intent === "project_metric" && plan.metric) {
    const metricRun = runs.find(
      (r) => r.tool === "getProjectMetric" && r.result.coverage !== "none",
    );
    const data = metricRun?.result.data as ProjectMetricValue | null | undefined;
    if (data && data.metric !== plan.metric) {
      return { ok: false, reason: "metric_mismatch" };
    }
  }

  return {
    ok: true,
    reason: coverage === "partial" ? "incomplete" : "answerable",
  };
}
