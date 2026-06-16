/**
 * Document search / RAG — PLACEHOLDER.
 *
 * Phase 2 will index uploaded company documents (embeddings + vector search)
 * and return the most relevant chunks here. For now this returns an empty array
 * so the orchestrator can call it unconditionally without any special-casing.
 *
 * When implemented, keep this same signature so the orchestrator does not change:
 *   - embed the query
 *   - run a vector similarity search over indexed document chunks
 *   - return the top-k matches as DocumentMatch[]
 */

import "server-only";

export interface DocumentMatch {
  /** Identifier of the source document. */
  documentId: string;
  /** Human-readable title or filename, for citation. */
  title: string;
  /** The matched text chunk to feed into the model context. */
  content: string;
  /** Similarity score (0–1). Optional until implemented. */
  score?: number;
}

/**
 * Search uploaded documents for content relevant to `query`.
 * Currently a no-op stub that returns no matches.
 */
export async function searchDocuments(query: string): Promise<DocumentMatch[]> {
  void query; // intentionally unused until RAG is implemented
  return [];
}
