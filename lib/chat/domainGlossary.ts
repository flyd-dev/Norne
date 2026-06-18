/**
 * Domain glossary — the single source of truth for Norwegian/English synonyms and
 * canonical concepts the chatbot reasons about.
 *
 * Field crews, the office and uploaded spreadsheets all use slightly different
 * words for the same thing (and a few recurring typos). Centralising the mappings
 * here means intent routing, document-search expansion, capacity parsing and
 * account lookup all expand the same way — so fixing a synonym in one place fixes
 * it everywhere, instead of patching each call site after a bad answer.
 *
 * Pure and dependency-free for easy testing. Role/trade aliases live in
 * lib/chat/roles.ts (canonical trades) and are re-exported here so callers have a
 * single import.
 */

import {
  ALL_ROLE_TERMS,
  CANONICAL_ROLES,
  normalizeRole,
  type CanonicalRole,
} from "@/lib/chat/roles";

export { ALL_ROLE_TERMS, CANONICAL_ROLES, normalizeRole };
export type { CanonicalRole };

/** High-level concepts the router and search expansion care about. */
export type Concept = "ppe" | "capacity" | "staffing_plan" | "account";

/**
 * Synonym clusters per concept, lowercased. If a message mentions any term in a
 * cluster, the whole cluster is available for query expansion so we reach the
 * right data even when the exact word is absent.
 *
 *   - ppe          → verneutstyr / PPE (work gloves, safety boots, HMS gear)
 *   - capacity     → available/free capacity (timer, kapasitet, ledig)
 *   - staffing_plan→ the bemanningsplan document family
 *   - account      → chart-of-accounts / posting questions (kontoplan, bokføring)
 */
export const CONCEPT_TERMS: Record<Concept, string[]> = {
  ppe: [
    "verneutstyr",
    "personlig verneutstyr",
    "ppe",
    "arbeidshansker",
    "hansker",
    "vernehansker",
    "vernesko",
    "vernebriller",
    "hjelm",
    "vernehjelm",
    "hørselvern",
    "arbeidsklær",
    "arbeidstøy",
    "verneklær",
    "hms",
    "hms-utstyr",
    "sikkerhetsutstyr",
    "driftsmateriell",
    "forbruksmateriell",
    "utstyr",
    "produksjonsutstyr",
  ],
  capacity: [
    "kapasitet",
    "tilgjengelig kapasitet",
    "ledig kapasitet",
    "tilgjengelig",
    "tilgjengelige timer",
    "ledig",
    "ledige timer",
    "disponibel",
    "available",
    "free",
  ],
  staffing_plan: [
    "bemanningsplan",
    "bemanning",
    "rotasjonsplan",
    "kapasitetsanalyse",
    "ressurser",
    "ressurs",
    "ressursplan",
  ],
  account: [
    "kontoplan",
    "konto",
    "kontoer",
    "kontonummer",
    "kontering",
    "konteres",
    "kontere",
    "bokføring",
    "bokføre",
    "bokfører",
    "føre på",
    "føres på",
    "regnskapskonto",
  ],
};

/** All terms across all concepts (lowercased), de-duplicated. */
export const ALL_GLOSSARY_TERMS: string[] = [
  ...new Set(Object.values(CONCEPT_TERMS).flat()),
];

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9æøå-]+/gi) ?? []).filter(
    (t) => t.length >= 2,
  );
}

/**
 * Concepts a message touches. A concept matches when any of its terms appears as
 * a token or substring of the (lowercased) message — substring matching catches
 * compound words like "vernehanskene".
 */
export function detectConcepts(text: string): Concept[] {
  const haystack = text.toLowerCase();
  const tokens = new Set(tokenize(text));
  const out: Concept[] = [];
  for (const concept of Object.keys(CONCEPT_TERMS) as Concept[]) {
    const hit = CONCEPT_TERMS[concept].some(
      (term) => tokens.has(term) || haystack.includes(term),
    );
    if (hit) out.push(concept);
  }
  return out;
}

/**
 * Expand free text into glossary search terms: the text's own tokens plus the
 * full synonym cluster of every concept it touches. Lowercased and de-duplicated.
 * Used by document-search expansion and account ranking so a colloquial word
 * ("arbeidshansker") still reaches its accounting category ("verneutstyr").
 */
export function expandGlossaryTerms(text: string): string[] {
  const out = new Set<string>(tokenize(text));
  for (const concept of detectConcepts(text)) {
    for (const term of CONCEPT_TERMS[concept]) out.add(term);
  }
  return [...out];
}

/** Convenience: the PPE/verneutstyr cluster, used by account-lookup expansion. */
export const PPE_TERMS = CONCEPT_TERMS.ppe;
