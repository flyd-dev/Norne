/**
 * Role / trade (fag) normalization for staffing-plan questions.
 *
 * Field crews and office staff use a mix of English and Norwegian role names,
 * plus common typos ("Stilfixer"). Capacity questions need a single canonical
 * role so demand and available hours line up. This module maps every known
 * variant to one of three canonical trades and exposes the full alias list so
 * intent detection and document search can expand the query.
 *
 * Pure and dependency-free for easy testing.
 */

/** Canonical trade names used everywhere downstream. */
export type CanonicalRole = "Welder" | "Steel fixer" | "Carpenter";

export const CANONICAL_ROLES: CanonicalRole[] = [
  "Welder",
  "Steel fixer",
  "Carpenter",
];

/**
 * Aliases per canonical role, lowercased. Includes English, Norwegian and the
 * typos we have actually seen ("stilfixer", "stalfikser"). Order does not matter;
 * matching is longest-alias-first so multi-word aliases win over substrings.
 */
const ROLE_ALIASES: Record<CanonicalRole, string[]> = {
  Welder: ["welder", "sveiser", "sveis", "sveising"],
  "Steel fixer": [
    "steel fixer",
    "steelfixer",
    "stilfixer",
    "stilfikser",
    "stålfikser",
    "stalfikser",
    "stålfixer",
    "stalfixer",
    "armeringsarbeider",
    "armeringsarbeid",
    "armering",
    "jernbinder",
  ],
  Carpenter: [
    "carpenter",
    "tømrer",
    "tomrer",
    "forskalingssnekker",
    "forskaling",
    "forskalingsnekker",
    "snekker",
  ],
};

/** All role alias strings (lowercased), longest first — useful for search expansion. */
export const ALL_ROLE_TERMS: string[] = Object.values(ROLE_ALIASES)
  .flat()
  .sort((a, b) => b.length - a.length);

/** Flat [alias, canonical] pairs, sorted longest-alias-first for greedy matching. */
const ALIAS_PAIRS: { alias: string; role: CanonicalRole }[] = (
  Object.entries(ROLE_ALIASES) as [CanonicalRole, string[]][]
)
  .flatMap(([role, aliases]) => aliases.map((alias) => ({ alias, role })))
  .sort((a, b) => b.alias.length - a.alias.length);

/**
 * Normalize an arbitrary role/trade string (a word or short phrase) to its
 * canonical trade, or null when nothing matches. Matching is case-insensitive
 * and tolerant of surrounding text — the longest matching alias wins so
 * "steel fixer" is not shadowed by a shorter partial.
 */
export function normalizeRole(text: string): CanonicalRole | null {
  const hay = text.toLowerCase();
  for (const { alias, role } of ALIAS_PAIRS) {
    if (hay.includes(alias)) return role;
  }
  return null;
}

/** True when the text mentions any known role/trade. */
export function mentionsRole(text: string): boolean {
  return normalizeRole(text) !== null;
}
