/**
 * Tool registry assembly — the single place that knows every tool the assistant
 * can use. The planner picks tool names from here; the runner dispatches them.
 */

import { ToolRegistry } from "@/lib/assistant/tools/registry";
import { getMonthlyCapacity, getAvailableCapacity } from "@/lib/assistant/tools/capacity";
import {
  getProjectMetric,
  getProjectSummary,
  getProjectList,
} from "@/lib/assistant/tools/projects";
import {
  searchChartOfAccounts,
  getAccountForPurchase,
} from "@/lib/assistant/tools/accounts";
import { searchUploadedDocuments } from "@/lib/assistant/tools/documents";
import { askClarifyingQuestion } from "@/lib/assistant/tools/clarify";

/** Build a registry with every tool registered. Cheap; safe to call per request. */
export function buildRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(getMonthlyCapacity)
    .register(getAvailableCapacity)
    .register(getProjectMetric)
    .register(getProjectSummary)
    .register(getProjectList)
    .register(searchChartOfAccounts)
    .register(getAccountForPurchase)
    .register(searchUploadedDocuments)
    .register(askClarifyingQuestion);
}

/** Every tool name (for the planner / LLM tool-choice schema). */
export const TOOL_NAMES = [
  "getMonthlyCapacity",
  "getAvailableCapacity",
  "getProjectMetric",
  "getProjectSummary",
  "getProjectList",
  "searchChartOfAccounts",
  "getAccountForPurchase",
  "searchUploadedDocuments",
  "askClarifyingQuestion",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
