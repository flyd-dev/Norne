/**
 * Vector store facade — picks the backend from VECTOR_BACKEND and exposes one
 * stable, async API to the rest of the RAG layer.
 *
 *   - "sqlite" (default): local better-sqlite3 + sqlite-vec file on a writable
 *     disk (VPS). Native module + local file.
 *   - "turso": managed libSQL over HTTP (serverless / Vercel), no native build,
 *     no local filesystem.
 *
 * The backend module is LAZY-loaded, so better-sqlite3 is never imported (and
 * never needs to compile) when VECTOR_BACKEND=turso — important on Vercel.
 *
 * The API is async because the Turso client is HTTP-based; the sqlite backend
 * wraps its synchronous calls. Both backends share these types.
 *
 * Server-side only.
 */

import "server-only";
import { env } from "@/lib/env";
import type { StoredChunk } from "@/lib/documents/types";

export interface VectorMatch extends StoredChunk {
  /** Distance from the query (lower = closer). */
  distance: number;
  /** Cosine similarity in [-1, 1] (vectors are unit-normalised). */
  similarity: number;
}

export interface UpsertChunk {
  documentId: string;
  documentName: string;
  fileType: string;
  sheetName?: string | null;
  chunkIndex: number;
  text: string;
}

/** Common interface both backends implement. */
export interface VectorBackend {
  ensureVectorStore(): Promise<void>;
  vectorCount(): Promise<number>;
  deleteDocumentVectors(documentId: string): Promise<void>;
  upsertDocumentChunks(
    documentId: string,
    chunks: UpsertChunk[],
    embeddings: number[][],
  ): Promise<void>;
  searchVectors(queryEmbedding: number[], limit: number): Promise<VectorMatch[]>;
  closeVectorStore(): Promise<void>;
}

let backend: VectorBackend | null = null;
let backendKind: "sqlite" | "turso" | null = null;

async function getBackend(): Promise<VectorBackend> {
  const kind = env.rag.vectorBackend();
  // Reset the cached backend if the selected kind changed (tests/scripts).
  if (backend && backendKind === kind) return backend;
  backend =
    kind === "turso"
      ? (await import("@/lib/rag/vectorStore.turso")).createTursoVectorStore()
      : (await import("@/lib/rag/vectorStore.sqlite")).createSqliteVectorStore();
  backendKind = kind;
  return backend;
}

export async function ensureVectorStore(): Promise<void> {
  return (await getBackend()).ensureVectorStore();
}

export async function vectorCount(): Promise<number> {
  return (await getBackend()).vectorCount();
}

export async function deleteDocumentVectors(documentId: string): Promise<void> {
  return (await getBackend()).deleteDocumentVectors(documentId);
}

export async function upsertDocumentChunks(
  documentId: string,
  chunks: UpsertChunk[],
  embeddings: number[][],
): Promise<void> {
  return (await getBackend()).upsertDocumentChunks(documentId, chunks, embeddings);
}

export async function searchVectors(
  queryEmbedding: number[],
  limit: number,
): Promise<VectorMatch[]> {
  return (await getBackend()).searchVectors(queryEmbedding, limit);
}

export async function closeVectorStore(): Promise<void> {
  if (!backend) return;
  await backend.closeVectorStore();
  backend = null;
  backendKind = null;
}
