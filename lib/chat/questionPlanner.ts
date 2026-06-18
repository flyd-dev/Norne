/**
 * Question planner — the reasoning/planning layer that runs BEFORE retrieval.
 *
 * The orchestrator used to wire intent → router → retrieval directly. That made
 * the assistant behave like a one-shot search engine: it picked a source
 * mechanically and forgot what the conversation had already established. The
 * planner sits in front of that pipeline and produces an explicit, inspectable
 * plan: what is the user really asking, which entity/metric does it concern, does
 * it need history to resolve, and which sources are actually relevant.
 *
 * Deterministic and dependency-free (no LLM call) — it composes the existing
 * intent/router heuristics with the entity and metric resolvers. The orchestrator
 * obeys the plan; the LLM still does the final natural-language reasoning.
 */

import type { DetectedIntent } from "@/lib/chat/intent";
import type { RouteDecision, SourceKind } from "@/lib/chat/router";
import { resolveMetric, type Metric } from "@/lib/chat/metricResolver";
import {
  resolveEntity,
  type ResolverConfidence,
} from "@/lib/chat/entityResolver";
import type { HistoryMessage } from "@/lib/chat/historyFacts";

export type PlanIntent =
  | "capabilities_help"
  | "project_summary"
  | "project_metric"
  | "account_lookup"
  | "staffing_capacity"
  | "monthly_capacity"
  | "document_question"
  | "general";

export interface PlanEntities {
  projectNumber?: string;
  projectName?: string;
  documentName?: string;
  role?: string;
  month?: string;
}

export interface QuestionPlan {
  intent: PlanIntent;
  entities: PlanEntities;
  metric?: Metric;
  /** True when resolving the question relies on prior conversation turns. */
  needsHistory: boolean;
  /** Sources worth checking, most-relevant first. */
  candidateSources: SourceKind[];
  /** Sources explicitly kept out for this question. */
  excludedSources: SourceKind[];
  confidence: ResolverConfidence;
}

/** Map a router Route + signals into the higher-level plan intent. */
function planIntentFrom(
  decision: RouteDecision,
  hasMetric: boolean,
  hasProject: boolean,
): PlanIntent {
  switch (decision.route) {
    case "account_lookup":
      return "account_lookup";
    case "staffing_capacity":
      return "staffing_capacity";
    case "monthly_capacity":
      return "monthly_capacity";
    case "budget_lines":
    case "quantities":
      return "project_metric";
    case "document_question":
      return "document_question";
    case "project_summary":
      // A project question that names a concrete metric is a metric lookup, not
      // an open-ended summary.
      return hasMetric && hasProject ? "project_metric" : "project_summary";
    default:
      return "general";
  }
}

export interface PlanInput {
  /** The user's original message. */
  message: string;
  /** Retrieval text (follow-up-enriched), used for intent/metric detection. */
  retrievalText: string;
  intent: DetectedIntent;
  decision: RouteDecision;
  history: HistoryMessage[];
  isFollowUp: boolean;
}

/**
 * Build the structured plan. Entity resolution here is message+history only (no
 * project list yet); the orchestrator re-resolves authoritatively once the list
 * is fetched, but the planner already knows the number/name/metric so it can pick
 * sources intelligently and drive the deterministic answer path.
 */
export function planQuestion(input: PlanInput): QuestionPlan {
  const { message, retrievalText, intent, decision, history, isFollowUp } = input;

  const metricMatch = resolveMetric(retrievalText);
  const entity = resolveEntity({ message, history });
  const hasProject = Boolean(entity.projectNumber || entity.projectName);

  const planIntent = planIntentFrom(
    decision,
    Boolean(metricMatch),
    hasProject,
  );

  const entities: PlanEntities = {};
  if (entity.projectNumber) entities.projectNumber = entity.projectNumber;
  if (entity.projectName) entities.projectName = entity.projectName;
  if (intent.capacityDemand?.startMonth) {
    entities.month = intent.capacityDemand.startMonth;
  }

  // History is needed when the project was only resolvable from prior turns, or
  // for any short follow-up reference.
  const needsHistory =
    isFollowUp ||
    (entity.matchedFrom.includes("history") &&
      !entity.matchedFrom.includes("message"));

  return {
    intent: planIntent,
    entities,
    ...(metricMatch ? { metric: metricMatch.metric } : {}),
    needsHistory,
    candidateSources: [...decision.allowedSources],
    excludedSources: [...decision.excludedSources],
    confidence: entity.confidence,
  };
}
