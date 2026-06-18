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
import type { Metric } from "@/lib/chat/metricResolver";
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

/** A money figure stated as currency ("150 705 668 kr") or a grouped number. */
const MONEY_WITH_UNIT_RE = /\d[\d   .]*\d\s*(kr|kroner|nok)\b/i;
const GROUPED_NUMBER_RE = /\b\d{1,3}(?:[   .]\d{3})+\b/;

/** True when the answer presents a concrete money amount (not a bare year/id). */
export function presentsMoneyFigure(answer: string): boolean {
  return MONEY_WITH_UNIT_RE.test(answer) || GROUPED_NUMBER_RE.test(answer);
}

export interface ContractGuardInput {
  metric?: Metric;
  answer: string;
  projectName: string | null;
  projectNumber: string | null;
  /** True when a true contract-value field was found (deterministic path). */
  hasVerifiedValue: boolean;
  /**
   * True when the ONLY numeric project data came from generic Endre amount
   * totals (project_amounts/cases/contracts) — i.e. no dedicated contract-value
   * field and no document content to draw a real contract value from.
   */
  onlyGenericEndreTotals: boolean;
}

export interface ContractGuardResult {
  triggered: boolean;
  replacement?: string;
  reason?: string;
}

/**
 * Stop a "kontraktsverdi" answer from passing off a generic Endre amount total
 * as the contract value. When the requested metric is the contract value, no
 * verified contract field was found, the only numbers available are generic
 * Endre totals, and the drafted answer nonetheless states a money figure, we
 * replace it with an honest "no dedicated contract-value field" answer.
 */
export function guardContractValue(input: ContractGuardInput): ContractGuardResult {
  if (input.metric !== "contract_value") return { triggered: false };
  if (input.hasVerifiedValue) return { triggered: false };
  if (!input.onlyGenericEndreTotals) return { triggered: false };
  if (!presentsMoneyFigure(input.answer)) return { triggered: false };

  const ref =
    input.projectName && input.projectNumber
      ? `${input.projectName} (prosjekt ${input.projectNumber})`
      : input.projectName ?? `prosjekt ${input.projectNumber ?? ""}`.trim();
  return {
    triggered: true,
    reason: "contract_value_unverified",
    replacement:
      `Jeg finner ${ref} i Endre, men jeg finner ikke et eget felt for ` +
      `kontraktsverdi i tilgjengelige data. Jeg finner derimot beløpsposter ` +
      `(under «amounts»/«contracts»). Vil du at jeg viser dem i stedet?`,
  };
}

/** A figure stated in hours ("31,5 timer", "1 200 timer"). */
const HOURS_FIGURE_RE = /\d[\d   .,]*\s*timer\b/i;

/** True when the answer presents a concrete hours figure. */
export function presentsHoursFigure(answer: string): boolean {
  return HOURS_FIGURE_RE.test(answer);
}

export interface CapacityGuardInput {
  /** True when the capacity tool returned coverage "none" for this turn. */
  coverageNone: boolean;
  answer: string;
}

export interface CapacityGuardResult {
  triggered: boolean;
  replacement?: string;
  reason?: string;
}

/**
 * Stop a capacity answer from inventing hours when the tool found no capacity
 * data at all (coverage "none"). If the draft nonetheless states an hours figure,
 * it was fabricated — replace it with an honest "no capacity data" response.
 * Never fires when the tool DID return data (full/partial), so a real per-fag
 * answer is untouched.
 */
export function guardUnsupportedCapacity(
  input: CapacityGuardInput,
): CapacityGuardResult {
  if (!input.coverageNone) return { triggered: false };
  if (!presentsHoursFigure(input.answer)) return { triggered: false };
  return {
    triggered: true,
    reason: "capacity_unverified",
    replacement:
      "Jeg finner ikke tilgjengelig kapasitet (timer per fag) for den etterspurte " +
      "perioden i bemanningsplanen. Last opp riktig bemanningsplan, eller oppgi " +
      "perioden på nytt, så regner jeg på det — jeg gjetter ikke på tall.",
  };
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
