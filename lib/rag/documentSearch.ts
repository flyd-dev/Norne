/**
 * Document search / RAG — keyword (term-frequency) search over stored chunks.
 *
 * MVP implementation: loads stored chunks and ranks them by how often the query
 * terms appear, plus configurable boosts (document-name, sheet-name and specific
 * terms) and an optional exclude list. This is modular — the public
 * `searchDocuments(query, ...)` signature is what the orchestrator depends on, so
 * it can later be swapped for embeddings/vector search without touching the
 * orchestrator.
 */

import "server-only";
import { getAllChunks } from "@/lib/documents/store";
import type { StoredChunk } from "@/lib/documents/types";

export interface DocumentMatch extends StoredChunk {
  /** Relevance score (higher = more relevant). */
  score: number;
}

/** Max chunks returned to the model (kept small to bound context size). */
export const MAX_DOCUMENT_MATCHES = 6;

/** Wider cap for capacity questions, which need most of the staffing plan. */
export const MAX_CAPACITY_MATCHES = 16;

export interface SearchOptions {
  /** Max chunks to return (defaults to MAX_DOCUMENT_MATCHES). */
  limit?: number;
  /** Substrings of document names to boost heavily (e.g. "bemanning"). */
  boostDocumentNames?: string[];
  /** Sheet names to boost (e.g. "Rotasjonsplan", "Kapasitet"). */
  boostSheetNames?: string[];
  /** Extra terms (roles, months) whose presence boosts a chunk. */
  boostTerms?: string[];
  /** Substrings of document names to exclude entirely (e.g. "kontoplan"). */
  excludeDocumentNames?: string[];
}

// Small Norwegian/English stopword list to reduce noise in matching.
const STOPWORDS = new Set([
  "og", "i", "på", "for", "av", "er", "en", "et", "som", "til", "med", "den",
  "det", "de", "har", "om", "hva", "hvilke", "hvilken", "finnes", "vis",
  "the", "a", "an", "of", "to", "in", "on", "is", "are", "what", "which", "show",
]);

function terms(query: string): string[] {
  const matched = query.toLowerCase().match(/[a-z0-9æøå]+/gi) ?? [];
  return matched.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Search uploaded documents for chunks relevant to `query`.
 *
 * Backwards compatible: the second argument may be a plain `limit` number, or a
 * `SearchOptions` object for boosts/excludes used by capacity questions.
 * Returns up to `limit` matches, highest score first.
 */
export async function searchDocuments(
  query: string,
  limitOrOptions: number | SearchOptions = MAX_DOCUMENT_MATCHES,
): Promise<DocumentMatch[]> {
  const options: SearchOptions =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : limitOrOptions;
  const limit = options.limit ?? MAX_DOCUMENT_MATCHES;
  const boostDocNames = (options.boostDocumentNames ?? []).map((s) =>
    s.toLowerCase(),
  );
  const boostSheets = (options.boostSheetNames ?? []).map((s) => s.toLowerCase());
  const boostTerms = (options.boostTerms ?? []).map((s) => s.toLowerCase());
  const excludeDocNames = (options.excludeDocumentNames ?? []).map((s) =>
    s.toLowerCase(),
  );

  const queryTerms = terms(query);
  if (queryTerms.length === 0 && boostTerms.length === 0) return [];

  const chunks = await getAllChunks();
  if (chunks.length === 0) return [];

  const scored: DocumentMatch[] = [];
  for (const chunk of chunks) {
    const name = chunk.documentName.toLowerCase();
    if (excludeDocNames.some((ex) => name.includes(ex))) continue;

    const text = chunk.text.toLowerCase();
    const sheet = (chunk.sheetName ?? "").toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      score += countOccurrences(text, term);
      if (name.includes(term)) score += 2; // boost document-name matches
    }

    // Boost chunks from a named staffing-plan document.
    if (boostDocNames.some((b) => name.includes(b))) score += 8;
    // Boost chunks from a relevant sheet (Rotasjonsplan, Bemanning, Kapasitet…).
    if (boostSheets.some((b) => sheet.includes(b))) score += 6;
    // Boost chunks that actually mention the roles/months we care about.
    for (const term of boostTerms) {
      if (text.includes(term)) score += 3;
    }

    if (score > 0) scored.push({ ...chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
