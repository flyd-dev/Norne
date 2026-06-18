/**
 * Clarification gate: decide when a question is too vague to answer without
 * relevant context from the current chat.
 *
 * A competent assistant asks a short clarifying question instead of guessing.
 * The classic failure mode is the opposite: a bare "Hva er kontraktsverdien?",
 * "Gi meg det du har frem til september 2026" or "Hva er status?" arrives with
 * no project/topic in focus, intent detection finds no keyword, and the pipeline
 * defaults to project (or capacity) data and invents a confident answer.
 *
 * This module answers ONE question: is the message context-dependent (it only
 * makes sense as a follow-up to something), and if so, of what kind? The
 * orchestrator then checks the conversation state: if there is no relevant prior
 * context for that kind, it returns a clarification instead of retrieving.
 *
 * Pure and dependency-free for easy testing.
 */

import { resolveMetric } from "@/lib/chat/metricResolver";
import { detectAccountLookup } from "@/lib/chat/accountLookup";
import { detectCapacityIntent, parseCapacityDemand } from "@/lib/chat/capacity";
import { parseMonthRange, parseMonth } from "@/lib/chat/dateRange";
import {
  extractProjectNameFromText,
  extractProjectNumberFromText,
} from "@/lib/chat/entityResolver";
import {
  hasRelevantContext as stateHasRelevantContext,
  type ConversationState,
} from "@/lib/chat/conversationState";

/** The single clarification prompt shown when context is missing. */
export const CLARIFICATION_QUESTION =
  "Jeg trenger litt mer kontekst. Mener du prosjektdata, bemanning/kapasitet, " +
  "kontoføring eller dokumentinnhold?";

/**
 * What sort of context a vague message would need:
 *   - "metric"  a bare project metric ("Hva er kontraktsverdien?") — needs a
 *               project in focus.
 *   - "period"  a bare time range ("frem til september 2026", "hva med august?")
 *               — needs a capacity/project request in focus.
 *   - "generic" an open reference ("vis det", "hva har vi?", "hva er status?")
 *               — needs any prior topic.
 */
export type ClarifyKind = "metric" | "period" | "generic";

export interface ContextDependence {
  /** True when the message cannot stand on its own. */
  dependent: boolean;
  /** The kind of context it would need, when dependent. */
  kind: ClarifyKind | null;
}

/** Generic, open-reference phrases that only make sense as a follow-up. */
const GENERIC_VAGUE: RegExp[] = [
  /\bvis\s+det\b/i,
  /\bdet\s+du\s+(har|fant|nevnte)\b/i, // "gi meg det du har"
  /\bhva\s+er\s+status(en)?\b/i,
  /\bhva\s+har\s+vi\b/i,
  /\bgi\s+meg\s+tall(ene|a)?\b/i,
  /^\s*status\s*\??\s*$/i,
  /^\s*tallene\s*\??\s*$/i,
];

/** "hva med <noe>?" — a follow-up that narrows the previous answer. */
const HVA_MED = /\bhva\s+med\s+(\w+)/i;

/** A four-digit year (e.g. 2026) — never a project number for anchor purposes. */
const YEAR_RE = /^20\d{2}$/;

/**
 * True when the message names a concrete entity it can be answered against
 * without prior context: an explicit project number (not a year), or a proper
 * noun used mid-sentence (e.g. "… på Pilestredet"). The sentence-initial word is
 * ignored because it is capitalised by convention ("Hva", "Gi", "Vis").
 */
function hasEntityAnchor(message: string): boolean {
  const labelled = extractProjectNumberFromText(message);
  if (labelled && !YEAR_RE.test(labelled)) {
    // extractProjectNumberFromText also returns bare numbers; reject years so a
    // trailing "… 2026" never reads as a project reference.
    return true;
  }
  // A named project written without the word "prosjekt" ("på Pilestredet"):
  // any capitalised proper-noun token that is NOT the first word.
  const words = message.trim().split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    if (/^["«(]?[A-ZÆØÅ][\wæøåÆØÅ-]+/.test(words[i])) return true;
  }
  // A "<Name> prosjektet" / "prosjekt <Name>" phrasing the helper recognises.
  if (extractProjectNameFromText(message)) return true;
  return false;
}

/** True when the message states a concrete capacity demand (hours or roles). */
function hasCapacityDemand(message: string): boolean {
  const demand = parseCapacityDemand(message);
  return Boolean(demand && (demand.totalHours !== null || demand.roles.length > 0));
}

/** True when the message carries a time-range or bare month/year reference. */
function hasPeriodReference(message: string): boolean {
  if (parseMonthRange(message)) return true;
  if (parseMonth(message)) return true;
  if (/\b(per|hver)\s+m(?:å|a)ned\b|\bm(?:å|a)nedlig\b|\but\s+(?:å|a)ret\b/i.test(message)) {
    return true;
  }
  return false;
}

/**
 * Classify whether a message is context-dependent. Conservative on purpose: a
 * false positive would hijack a perfectly answerable question. A message with
 * its own entity anchor (named/numbered project) or concrete capacity demand is
 * never dependent.
 */
export function analyzeContextDependence(message: string): ContextDependence {
  const text = message.trim();
  if (!text) return { dependent: false, kind: null };

  // Self-sufficient signals win — never clarify these. A capacity question
  // ("Har vi kapasitet i august?") stands on its own even without numbers: it
  // routes to the staffing plan, which says what (if anything) is missing.
  if (detectAccountLookup(text).isLookup) return { dependent: false, kind: null };
  if (detectCapacityIntent(text)) return { dependent: false, kind: null };
  if (hasCapacityDemand(text)) return { dependent: false, kind: null };
  if (hasEntityAnchor(text)) return { dependent: false, kind: null };

  // A bare project metric with no entity in the message ("Hva er
  // kontraktsverdien?") — needs a project in focus from the chat.
  if (resolveMetric(text)) {
    return { dependent: true, kind: "metric" };
  }

  // A bare period/time-range reference ("Gi meg det du har frem til september
  // 2026", "hva med august?") — needs a capacity/project request in focus.
  if (hasPeriodReference(text)) {
    return { dependent: true, kind: "period" };
  }

  // "hva med <måned>?" caught above by hasPeriodReference; any other "hva med X?"
  // is a generic narrowing follow-up.
  if (HVA_MED.test(text)) {
    return { dependent: true, kind: "generic" };
  }

  // Open references that only make sense as a continuation.
  if (GENERIC_VAGUE.some((re) => re.test(text))) {
    return { dependent: true, kind: "generic" };
  }

  return { dependent: false, kind: null };
}

export interface ClarifyDecision {
  /** True when the orchestrator should clarify instead of answering. */
  required: boolean;
  question: string | null;
  kind: ClarifyKind | null;
  /** Coded reason, for diagnostics. */
  reason: string | null;
}

/**
 * Decide whether to clarify: the message is context-dependent AND the current
 * chat has no relevant context for that kind. With relevant context (e.g. a
 * project just summarised, or a capacity request just made) the question is
 * answered normally by the rest of the pipeline.
 */
export function decideClarification(
  message: string,
  state: ConversationState,
): ClarifyDecision {
  const dep = analyzeContextDependence(message);
  if (!dep.dependent || !dep.kind) {
    return { required: false, question: null, kind: null, reason: null };
  }
  if (stateHasRelevantContext(state, dep.kind)) {
    return { required: false, question: null, kind: dep.kind, reason: "context_present" };
  }
  return {
    required: true,
    question: CLARIFICATION_QUESTION,
    kind: dep.kind,
    reason: `vague_${dep.kind}_no_context`,
  };
}
