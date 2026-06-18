/**
 * Lightweight answer verification, run before the response is returned.
 *
 * The model is capable but the surrounding app must not let it regress to "jeg
 * har ikke nok informasjon" when the value is actually known. This verifier is
 * rule-based: given what the user asked (the plan) and a known value (from a
 * structured source or history), it checks the drafted answer and, if the answer
 * fails to address the question, returns a deterministic replacement.
 *
 * It also strips sources that are not relevant to the question (e.g. an Endre
 * "projects" source that did not actually contain the resolved project).
 *
 * Pure and dependency-free for easy testing.
 */

import type { QuestionPlan } from "@/lib/chat/questionPlanner";
import type { SourceKind } from "@/lib/chat/router";
import {
  buildProjectMetricAnswer,
  formatNumberNo,
  type MetricValueSource,
} from "@/lib/chat/projectMetricAnswer";

const MISSING_INFO_RE =
  /(ikke nok informasjon|har ikke nok|finner ikke nok|mangler informasjon|kan ikke svare)/i;

export interface KnownMetricValue {
  value: number | string;
  source: MetricValueSource;
  projectName: string | null;
  projectNumber: string | null;
}

export interface VerifyInput {
  plan: QuestionPlan;
  question: string;
  answer: string;
  /** A value we know to be correct, if the deterministic path found one. */
  known?: KnownMetricValue | null;
}

export interface VerifyResult {
  /** True when the drafted answer is acceptable as-is. */
  ok: boolean;
  /** A replacement answer to use instead, when the draft was inadequate. */
  replacement?: string;
  /** Coded reason for a replacement, for diagnostics. */
  reason?: string;
}

/** True when the answer text contains the known value in a recognisable form. */
function answerContainsValue(answer: string, value: number | string): boolean {
  if (typeof value === "string") {
    return answer.toLowerCase().includes(value.toLowerCase());
  }
  // Accept either the spaced Norwegian form or the raw digits.
  const spaced = formatNumberNo(value);
  const compact = String(Math.round(value));
  const normalizedAnswer = answer.replace(/[   ]/g, " ");
  return (
    normalizedAnswer.includes(spaced) ||
    normalizedAnswer.replace(/\s/g, "").includes(compact)
  );
}

/**
 * Verify a drafted answer against the plan and any known value. When a value is
 * known but the draft omits it or claims missing information, replace the draft
 * with a deterministic, correct answer.
 */
export function verifyAnswer(input: VerifyInput): VerifyResult {
  const { plan, question, answer, known } = input;

  if (known && (plan.intent === "project_metric" || plan.metric)) {
    const saysMissing = MISSING_INFO_RE.test(answer);
    const hasValue = answerContainsValue(answer, known.value);
    if (saysMissing || !hasValue) {
      return {
        ok: false,
        reason: saysMissing ? "answer_claimed_missing" : "value_not_in_answer",
        replacement: buildProjectMetricAnswer({
          metric: plan.metric!,
          value: known.value,
          projectName: known.projectName,
          projectNumber: known.projectNumber,
          question,
        }),
      };
    }
  }

  return { ok: true };
}

/** Maps a route-excluded SourceKind to the source label it appears as. */
const SOURCE_LABELS: Partial<Record<SourceKind, string>> = {
  accounts: "accounts",
  projects: "projects",
  staffingPlan: "staffingPlan",
};

export interface PruneOptions {
  /** SourceKinds the route excluded — their labels are dropped from sources. */
  excludedSources: SourceKind[];
  /** True when Endre actually contributed to the answer; false drops Endre labels. */
  endreContributed: boolean;
}

export interface PruneResult {
  sources: string[];
  /** True when an "accounts" source was pruned (for diagnostics). */
  prunedAccounts: boolean;
}

/**
 * Drop sources that are not relevant to the answer:
 *   - an Endre "Endre API: …" source that contributed nothing, and
 *   - a collection label (accounts/projects/…) the route explicitly excluded but
 *     that was fetched anyway (e.g. the broad projects+accounts fallback).
 *
 * Keeps source order; never adds anything.
 */
export function pruneSources(
  sources: string[],
  opts: PruneOptions,
): PruneResult {
  const drop = new Set<string>();
  for (const kind of opts.excludedSources) {
    const label = SOURCE_LABELS[kind];
    if (label) drop.add(label);
  }
  let prunedAccounts = false;
  const pruned = sources.filter((s) => {
    if (s.startsWith("Endre API:") && !opts.endreContributed) return false;
    if (drop.has(s)) {
      if (s === "accounts") prunedAccounts = true;
      return false;
    }
    return true;
  });
  return { sources: pruned, prunedAccounts };
}
