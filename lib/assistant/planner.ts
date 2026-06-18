/**
 * Tool selection (plan point 6 → 8).
 *
 * Maps the existing deterministic QuestionPlan + ChatState onto the tools that
 * should run this turn. This is the DEFAULT, deterministic path — fast, free and
 * testable — and it enforces the source policy by construction: a project
 * question only ever selects project tools, a capacity question only capacity
 * tools, etc. (plan point 6). When the question is too vague and the chat has no
 * relevant context, it selects clarification instead of fetching random data.
 *
 * An LLM tool-choice loop is the intended extension for the long tail of
 * phrasings (plan point 8): when `confidence` is low it can pick among these same
 * tools. That hook lives in the runner; the tools and their schemas are shared,
 * and the source policy below still bounds whatever the model may choose.
 */

import type { QuestionPlan } from "@/lib/chat/questionPlanner";
import type { ChatState } from "@/lib/assistant/state/chatState";
import type { ToolName } from "@/lib/assistant/tools/index";

export interface ToolPlan {
  /** Tools to run this turn, in order. Empty when clarifying. */
  tools: ToolName[];
  /** True when the runner should clarify instead of fetching. */
  clarify: boolean;
  clarifyReason?: string;
  /** Whether an LLM tool-choice pass is advisable (low deterministic confidence). */
  llmFallbackAdvised: boolean;
}

/** Deterministic intent → tool mapping. One source policy, in one place. */
function toolsForIntent(plan: QuestionPlan): ToolName[] {
  switch (plan.intent) {
    case "monthly_capacity":
      return ["getMonthlyCapacity"];
    case "staffing_capacity":
      return ["getAvailableCapacity"];
    case "project_metric":
      return ["getProjectMetric"];
    case "project_summary":
      return ["getProjectSummary"];
    case "project_list":
      return ["getProjectList"];
    case "account_lookup":
      return ["getAccountForPurchase"];
    case "account_list":
      return ["searchChartOfAccounts"];
    case "document_question":
      return ["searchUploadedDocuments"];
    case "capabilities_help":
    case "general":
      return [];
  }
}

/**
 * Select tools for the turn. `clarify` is decided upstream (decideClarification
 * over the conversation state) and passed in, so this stays a pure mapping.
 */
export function selectTools(
  plan: QuestionPlan,
  state: ChatState,
  clarify: { required: boolean; reason: string | null },
): ToolPlan {
  if (clarify.required) {
    return {
      tools: [],
      clarify: true,
      clarifyReason: clarify.reason ?? "vague_no_context",
      llmFallbackAdvised: false,
    };
  }

  const tools = toolsForIntent(plan);
  // A general/help question with no obvious tool, in a chat that also lacks
  // context, is a clarification candidate rather than a random fetch.
  if (tools.length === 0 && !state.hasContext) {
    return {
      tools: [],
      clarify: true,
      clarifyReason: "no_tool_no_context",
      llmFallbackAdvised: false,
    };
  }

  return {
    tools,
    clarify: false,
    // Low confidence (e.g. ambiguous entity/metric) → worth an LLM tool-choice
    // pass over the same tools, bounded by the source policy above.
    llmFallbackAdvised: plan.confidence === "low" && tools.length > 0,
  };
}
