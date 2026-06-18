/**
 * Lightweight intent detection.
 *
 * Decides which Firestore collections a question is about, using Norwegian and
 * English keywords. Deliberately simple and dependency-free — this is a routing
 * heuristic, not the answer engine. The LLM still does the actual reasoning over
 * whatever data we retrieve.
 */

import { detectAccountLookup } from "@/lib/chat/accountLookup";
import {
  detectCapacityIntent,
  parseCapacityDemand,
  type CapacityDemand,
} from "@/lib/chat/capacity";

export type Topic = "accounts" | "projects" | "budgetLines" | "quantities";

const KEYWORDS: Record<Topic, RegExp> = {
  // kontoer / regnskapskontoer
  accounts: /\b(account|accounts|konto|kontoer|kontoene|regnskapskonto)\b/i,
  // prosjekter
  projects: /\b(project|projects|prosjekt|prosjekter|prosjektet|prosjektene)\b/i,
  // budsjettlinjer / budsjett
  budgetLines:
    /\b(budget|budgets|budget[\s_-]?line|budget[\s_-]?lines|budsjett|budsjettlinje|budsjettlinjer|kostnad|kostnader)\b/i,
  // mengder / kvantum
  quantities:
    /\b(quantity|quantities|mengde|mengder|mengden|kvantum|antall)\b/i,
};

export interface DetectedIntent {
  topics: Topic[];
  /** True when the question is about per-project data (budget lines / quantities). */
  needsProject: boolean;
  /** A project id explicitly present in the message, if any. */
  explicitProjectId: string | null;
  /** True when the user is asking which account to post something on. */
  accountLookup: boolean;
  /** The thing being posted (X in "Hva fører jeg X på?"), if a lookup. */
  lookupSubject: string | null;
  /** Subject + related accounting terms to drive document/account search. */
  searchTerms: string[];
  /** True when the question is about staffing/capacity (bemanningsplan). */
  capacity: boolean;
  /** Parsed project demand for a capacity question, if any. */
  capacityDemand: CapacityDemand | null;
}

/**
 * Try to spot an explicit Firestore-style document id in the message
 * (20-char alphanumeric, e.g. "GSLeXiSkaiAkEqcuFxIx").
 */
function extractExplicitProjectId(message: string): string | null {
  const match = message.match(/\b[A-Za-z0-9]{20}\b/);
  return match ? match[0] : null;
}

export function detectIntent(message: string): DetectedIntent {
  const lookup = detectAccountLookup(message);
  const capacity = !lookup.isLookup && detectCapacityIntent(message);

  const topics: Topic[] = [];
  for (const topic of Object.keys(KEYWORDS) as Topic[]) {
    if (KEYWORDS[topic].test(message)) topics.push(topic);
  }

  if (lookup.isLookup) {
    // "Hva fører jeg X på?" is always an accounts question, but the subject (X)
    // rarely contains the word "konto" — so force the accounts topic. Do NOT pull
    // in projects unless the user clearly asked about a project; an account
    // lookup should not drag in unrelated project summaries.
    if (!topics.includes("accounts")) topics.push("accounts");
  } else if (capacity) {
    // Staffing/capacity questions are answered from the uploaded staffing plan,
    // not Firestore — do NOT drag in account/project summaries.
    for (let i = topics.length - 1; i >= 0; i--) {
      if (topics[i] === "accounts" || topics[i] === "projects") topics.splice(i, 1);
    }
  } else if (topics.length === 0) {
    // If nothing matched, default to projects + accounts as the broad overview.
    topics.push("projects", "accounts");
  }

  const needsProject =
    topics.includes("budgetLines") || topics.includes("quantities");

  return {
    topics,
    needsProject,
    explicitProjectId: extractExplicitProjectId(message),
    accountLookup: lookup.isLookup,
    lookupSubject: lookup.subject,
    searchTerms: lookup.expandedTerms,
    capacity,
    capacityDemand: capacity ? parseCapacityDemand(message) : null,
  };
}

// Project resolution now lives in lib/chat/projectResolver.ts (resolveProject),
// which supports id + configurable name fields, ambiguity and not-found results.
