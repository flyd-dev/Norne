/**
 * Document search / RAG — keyword (term-frequency) search over stored chunks.
 *
 * MVP implementation: loads stored chunks and ranks them by how often the query
 * terms appear (plus a boost when the document name matches). This is modular —
 * the public `searchDocuments(query)` signature is what the orchestrator depends
 * on, so it can later be swapped for embeddings/vector search without touching
 * the orchestrator.
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
 * Returns up to `limit` matches (default MAX_DOCUMENT_MATCHES), highest score first.
 */
export async function searchDocuments(
  query: string,
  limit: number = MAX_DOCUMENT_MATCHES,
): Promise<DocumentMatch[]> {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return [];

  const chunks = await getAllChunks();
  if (chunks.length === 0) return [];

  const scored: DocumentMatch[] = [];
  for (const chunk of chunks) {
    const text = chunk.text.toLowerCase();
    const name = chunk.documentName.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      score += countOccurrences(text, term);
      if (name.includes(term)) score += 2; // boost document-name matches
    }
    if (score > 0) scored.push({ ...chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
