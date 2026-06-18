/**
 * Account-lookup intent: "Hva fører jeg X på?"
 *
 * Norwegian bookkeeping questions ask which account (konto/kontonummer) a cost
 * should be posted to. These are easy to recognise by phrasing but the subject
 * (X) is often a colloquial word ("arbeidshansker") that does not appear verbatim
 * in the chart of accounts. So we:
 *
 *   1. Detect the posting-question phrasing and pull out the subject X.
 *   2. Expand X with related accounting terms (synonyms + category words) so the
 *      document/account search can find the closest matching account even when
 *      the exact word is missing.
 *   3. Rank the accounts collection by those terms so we send the model the top
 *      relevant accounts instead of dumping the whole chart.
 *
 * Pure and dependency-free for easy testing. The orchestrator decides how to use
 * the result; this module only classifies and expands.
 */

import type { FirestoreDoc } from "@/lib/firestore/types";
import { PPE_TERMS } from "@/lib/chat/domainGlossary";

export interface AccountLookup {
  /** True when the message is a "where do I post X" accounting question. */
  isLookup: boolean;
  /** The thing being posted (X), as written by the user; null if not a lookup. */
  subject: string | null;
  /** Subject + related accounting terms, lowercased and de-duplicated. */
  expandedTerms: string[];
}

/**
 * Posting-question patterns. Each captures the subject (X) in group 1.
 * Ordered most-specific first; the first match wins.
 */
const LOOKUP_PATTERNS: RegExp[] = [
  // Hva fører jeg X på?
  /\bhva\s+f(?:ø|o)rer\s+jeg\s+(.+?)\s+p(?:å|a)(?![a-zæøå])/i,
  // Hva skal X konteres på? / Hva skal X føres på?
  /\bhva\s+skal\s+(.+?)\s+(?:konteres|f(?:ø|o)res|bokf(?:ø|o)res)\b/i,
  // Hva føres X som? / Hva bokføres X som?
  /\bhva\s+(?:f(?:ø|o)res|bokf(?:ø|o)res|konteres)\s+(.+?)\s+som\b/i,
  // Hvilken konto bruker jeg for X? / Hvilken konto skal jeg bruke til X?
  /\bhvilken\s+konto\s+(?:bruker|brukes|skal)\b.*?\b(?:for|til|på)\s+(.+?)[?.!]*$/i,
  // Hvilket kontonummer for X? / Hvilket kontonummer bruker jeg til X?
  /\bhvilket\s+kontonummer\b.*?\b(?:for|til|på)\s+(.+?)[?.!]*$/i,
  // Hvor bokfører jeg X? / Hvor konterer jeg X?
  /\bhvor\s+(?:bokf(?:ø|o)rer|konterer|f(?:ø|o)rer)\s+jeg\s+(.+?)[?.!]*$/i,
  // Hvor skal jeg føre X? / Hvor skal X føres?
  /\bhvor\s+skal\s+jeg\s+(?:f(?:ø|o)re|bokf(?:ø|o)re|kontere)\s+(.+?)[?.!]*$/i,
  /\bhvor\s+skal\s+(.+?)\s+(?:f(?:ø|o)res|bokf(?:ø|o)res|konteres)\b/i,
];

/** Words to strip from the front of a captured subject. */
const SUBJECT_STOPWORDS = new Set([
  "en", "et", "ei", "de", "den", "det", "mine", "min", "mitt", "disse", "slike",
  "noen", "ene", "selve",
]);

/**
 * Clusters of related accounting terms. If a subject mentions any word in a
 * cluster, the whole cluster is added to the search so we can reach the right
 * account category even when the exact word is absent from the chart. The
 * protective-gear / HMS cluster is sourced from the shared domain glossary
 * (lib/chat/domainGlossary.ts) so synonyms stay in one place.
 */
const SYNONYM_CLUSTERS: string[][] = [PPE_TERMS];

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9æøå-]+/gi) ?? []).filter(
    (t) => t.length >= 2,
  );
}

/** Trim punctuation and leading filler words from a captured subject. */
function cleanSubject(raw: string): string {
  let subject = raw.trim().replace(/[?.!,;:]+$/g, "").trim();
  const words = subject.split(/\s+/);
  while (words.length > 1 && SUBJECT_STOPWORDS.has(words[0].toLowerCase())) {
    words.shift();
  }
  subject = words.join(" ");
  return subject;
}

/**
 * Expand a subject into search terms: the subject's own words plus any related
 * accounting terms from a matching synonym cluster. Lowercased, de-duplicated.
 */
export function expandSearchTerms(subject: string): string[] {
  const base = tokenize(subject);
  const out = new Set<string>(base);
  const haystack = subject.toLowerCase();
  for (const cluster of SYNONYM_CLUSTERS) {
    const hit =
      cluster.some((word) => base.includes(word)) ||
      cluster.some((word) => haystack.includes(word));
    if (hit) for (const word of cluster) out.add(word);
  }
  return [...out];
}

/**
 * Detect a "where do I post X" accounting question and extract + expand X.
 */
export function detectAccountLookup(message: string): AccountLookup {
  for (const pattern of LOOKUP_PATTERNS) {
    const match = message.match(pattern);
    if (match && match[1]) {
      const subject = cleanSubject(match[1]);
      if (subject.length === 0) continue;
      return {
        isLookup: true,
        subject,
        expandedTerms: expandSearchTerms(subject),
      };
    }
  }
  return { isLookup: false, subject: null, expandedTerms: [] };
}

/** Internal id-like field names we never match account text against. */
const ID_FIELD = /(^id$)|(_id$)|(_uid$)/i;

function accountText(account: FirestoreDoc): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(account)) {
    if (ID_FIELD.test(key)) continue;
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
    }
  }
  return parts.join(" ").toLowerCase();
}

export interface RankedAccount {
  account: FirestoreDoc;
  score: number;
}

/**
 * Rank accounts by how many of `terms` appear in their text fields. Returns only
 * accounts that match at least one term, highest score first, capped at `limit`.
 * Empty result means nothing matched — the caller decides on a fallback.
 */
export function rankAccounts(
  accounts: FirestoreDoc[],
  terms: string[],
  limit: number,
): RankedAccount[] {
  const needles = [...new Set(terms.map((t) => t.toLowerCase()))].filter(
    (t) => t.length >= 2,
  );
  if (needles.length === 0) return [];

  const scored: RankedAccount[] = [];
  for (const account of accounts) {
    const text = accountText(account);
    let score = 0;
    for (const needle of needles) {
      if (text.includes(needle)) score += 1;
    }
    if (score > 0) scored.push({ account, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
