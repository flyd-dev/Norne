/**
 * Document search / RAG.
 *
 * Two backends behind one stable `searchDocuments(query, ...)` signature (what
 * the orchestrator depends on):
 *
 *   - Semantic (default when EMBEDDINGS_PROVIDER ≠ "none" and the sqlite-vec
 *     index is populated): embeds the query and runs a KNN search over chunk
 *     embeddings. Scales to large corpora (e.g. a synced SharePoint library).
 *   - Keyword (fallback): term-frequency ranking over the in-memory JSON chunk
 *     store. Used when embeddings are disabled, the vector index is empty, or the
 *     embedding call fails — so chat never hard-fails on a retrieval hiccup.
 *
 * The same metadata boosts/excludes (document-name, sheet-name, terms) are
 * applied on top of BOTH backends, so capacity-question tuning is preserved.
 */

import "server-only";
import { getAllChunks } from "@/lib/documents/store";
import type { StoredChunk } from "@/lib/documents/types";
import { embedQuery, embeddingsEnabled } from "@/lib/rag/embeddings";
import { searchVectors, vectorCount } from "@/lib/rag/vectorStore";
import { errorTypeOf } from "@/lib/logger";

export interface DocumentMatch extends StoredChunk {
  /** Relevance score (higher = more relevant). */
  score: number;
}

/** Max chunks returned to the model (kept small to bound context size). */
export const MAX_DOCUMENT_MATCHES = 6;

/** Wider cap for capacity questions, which need most of the staffing plan. */
export const MAX_CAPACITY_MATCHES = 16;

/** Widest cap for broad case/overview questions ("hele saken"), which span many
 * documents. Used when there is no dossier to lean on. */
export const MAX_CASE_MATCHES = 40;

/** Lighter cap for broad case/overview questions WHEN the resident case dossier
 * is available: the dossier already carries the whole-case breadth, so we only
 * need a few supporting chunks for citations/detail. Keeping this small is what
 * makes case answers fast — no 40-chunk sweep on every question. */
export const MAX_CASE_MATCHES_WITH_DOSSIER = 10;

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

interface NormalizedOptions {
  limit: number;
  boostDocNames: string[];
  boostSheets: string[];
  boostTerms: string[];
  excludeDocNames: string[];
}

function normalizeOptions(
  limitOrOptions: number | SearchOptions,
): NormalizedOptions {
  const options: SearchOptions =
    typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  return {
    limit: options.limit ?? MAX_DOCUMENT_MATCHES,
    boostDocNames: (options.boostDocumentNames ?? []).map((s) => s.toLowerCase()),
    boostSheets: (options.boostSheetNames ?? []).map((s) => s.toLowerCase()),
    boostTerms: (options.boostTerms ?? []).map((s) => s.toLowerCase()),
    excludeDocNames: (options.excludeDocumentNames ?? []).map((s) =>
      s.toLowerCase(),
    ),
  };
}

/** Additive metadata boost shared by both backends; returns 0 when excluded. */
function metadataBoost(
  chunk: StoredChunk,
  opts: NormalizedOptions,
): number | null {
  const name = chunk.documentName.toLowerCase();
  if (opts.excludeDocNames.some((ex) => name.includes(ex))) return null;
  const sheet = (chunk.sheetName ?? "").toLowerCase();
  const text = chunk.text.toLowerCase();
  let boost = 0;
  if (opts.boostDocNames.some((b) => name.includes(b))) boost += 8;
  if (opts.boostSheets.some((b) => sheet.includes(b))) boost += 6;
  for (const term of opts.boostTerms) {
    if (text.includes(term)) boost += 3;
  }
  return boost;
}

/** Keyword (term-frequency) ranking over the in-memory JSON chunk store. */
async function keywordSearch(
  query: string,
  opts: NormalizedOptions,
): Promise<DocumentMatch[]> {
  const queryTerms = terms(query);
  if (queryTerms.length === 0 && opts.boostTerms.length === 0) return [];

  const chunks = await getAllChunks();
  if (chunks.length === 0) return [];

  const scored: DocumentMatch[] = [];
  for (const chunk of chunks) {
    const boost = metadataBoost(chunk, opts);
    if (boost === null) continue; // excluded
    const name = chunk.documentName.toLowerCase();
    const text = chunk.text.toLowerCase();
    let score = boost;
    for (const term of queryTerms) {
      score += countOccurrences(text, term);
      if (name.includes(term)) score += 2; // boost document-name matches
    }
    if (score > 0) scored.push({ ...chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit);
}

/** Semantic (embedding KNN) search over the sqlite-vec index. */
async function semanticSearch(
  query: string,
  opts: NormalizedOptions,
): Promise<DocumentMatch[]> {
  const queryVec = await embedQuery(query);
  // Over-fetch so metadata boosts/excludes can re-rank a wider candidate set.
  const candidates = await searchVectors(queryVec, Math.max(opts.limit * 4, 24));

  const scored: DocumentMatch[] = [];
  for (const c of candidates) {
    const boost = metadataBoost(c, opts);
    if (boost === null) continue; // excluded
    // Map cosine similarity [-1,1] onto a 0–10 scale comparable to the additive
    // boosts, so hybrid ranking stays coherent.
    const score = c.similarity * 10 + boost;
    scored.push({
      documentId: c.documentId,
      documentName: c.documentName,
      fileType: c.fileType,
      sheetName: c.sheetName,
      chunkIndex: c.chunkIndex,
      text: c.text,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit);
}

/**
 * Search uploaded documents for chunks relevant to `query`.
 *
 * Backwards compatible: the second argument may be a plain `limit` number, or a
 * `SearchOptions` object for boosts/excludes used by capacity questions.
 * Returns up to `limit` matches, highest score first.
 *
 * Uses semantic search when available, falling back to keyword search.
 */
export async function searchDocuments(
  query: string,
  limitOrOptions: number | SearchOptions = MAX_DOCUMENT_MATCHES,
): Promise<DocumentMatch[]> {
  const opts = normalizeOptions(limitOrOptions);

  if (embeddingsEnabled()) {
    try {
      if ((await vectorCount()) > 0) {
        const results = await semanticSearch(query, opts);
        if (results.length > 0) return results;
      }
    } catch (error) {
      // Never hard-fail chat on a retrieval hiccup (e.g. Ollama down) — log the
      // error type only and fall back to keyword search.
      console.error(
        JSON.stringify({
          evt: "semantic_search_failed_fallback_keyword",
          errorType: errorTypeOf(error),
        }),
      );
    }
  }

  return keywordSearch(query, opts);
}
