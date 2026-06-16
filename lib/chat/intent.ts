/**
 * Lightweight intent detection.
 *
 * Decides which Firestore collections a question is about, using Norwegian and
 * English keywords. Deliberately simple and dependency-free — this is a routing
 * heuristic, not the answer engine. The LLM still does the actual reasoning over
 * whatever data we retrieve.
 */

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
  const topics: Topic[] = [];
  for (const topic of Object.keys(KEYWORDS) as Topic[]) {
    if (KEYWORDS[topic].test(message)) topics.push(topic);
  }

  // If nothing matched, default to projects + accounts as the broad overview.
  if (topics.length === 0) {
    topics.push("projects", "accounts");
  }

  const needsProject =
    topics.includes("budgetLines") || topics.includes("quantities");

  return {
    topics,
    needsProject,
    explicitProjectId: extractExplicitProjectId(message),
  };
}

// Project resolution now lives in lib/chat/projectResolver.ts (resolveProject),
// which supports id + configurable name fields, ambiguity and not-found results.
