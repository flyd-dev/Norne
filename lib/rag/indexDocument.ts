/**
 * Shared indexing helper: embed a document's chunks and upsert them into the
 * sqlite-vec store. Used by BOTH the admin upload route and the SharePoint sync,
 * so semantic search stays populated no matter how a document arrived.
 *
 * Resilient by design: a no-op when embeddings are disabled, and on embedding
 * failure it throws to the caller (which logs + continues) — the keyword
 * fallback in documentSearch keeps chat working regardless.
 *
 * Server-side only.
 */

import "server-only";
import { getAllChunks } from "@/lib/documents/store";
import type { DocumentChunk } from "@/lib/documents/types";
import { embedTexts, embeddingsEnabled } from "@/lib/rag/embeddings";
import {
  deleteDocumentVectors,
  ensureVectorStore,
  upsertDocumentChunks,
  type UpsertChunk,
} from "@/lib/rag/vectorStore";

/** Embed in modest batches so a large document doesn't make one huge request. */
const EMBED_BATCH = 64;

/**
 * Index a document's chunks for semantic search (replaces any existing vectors
 * for the same documentId). No-op when embeddings are disabled.
 */
export async function indexDocumentChunks(
  documentId: string,
  chunks: DocumentChunk[],
): Promise<void> {
  if (!embeddingsEnabled()) return;
  await ensureVectorStore();

  if (chunks.length === 0) {
    await deleteDocumentVectors(documentId);
    return;
  }

  const upserts: UpsertChunk[] = [];
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const embeddings = await embedTexts(batch.map((c) => c.text));
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      upserts.push({
        documentId: c.documentId,
        documentName: c.documentName,
        fileType: c.fileType,
        sheetName: c.sheetName,
        chunkIndex: c.chunkIndex,
        text: c.text,
      });
      vectors.push(embeddings[j]);
    }
  }

  await upsertDocumentChunks(documentId, upserts, vectors);
}

/** Remove a document's vectors (call when a document is deleted). */
export async function removeDocumentFromIndex(documentId: string): Promise<void> {
  if (!embeddingsEnabled()) return;
  await deleteDocumentVectors(documentId);
}

export interface ReindexResult {
  documents: number;
  chunks: number;
}

/**
 * Rebuild the semantic index from every chunk already in the JSON store. Use
 * this once after enabling embeddings (or after re-uploading) to backfill
 * documents that were stored before semantic search existed.
 */
export async function reindexAllFromJsonStore(): Promise<ReindexResult> {
  if (!embeddingsEnabled()) return { documents: 0, chunks: 0 };
  await ensureVectorStore();

  const all = await getAllChunks();
  // Group chunks by their owning document so each is upserted atomically.
  const byDoc = new Map<string, DocumentChunk[]>();
  for (const c of all) {
    const list = byDoc.get(c.documentId) ?? [];
    list.push({
      documentId: c.documentId,
      documentName: c.documentName,
      fileType: c.fileType as DocumentChunk["fileType"],
      sheetName: c.sheetName ?? null,
      chunkIndex: c.chunkIndex,
      text: c.text,
      // uploadedAt is unused by the vector store; supply a placeholder.
      uploadedAt: "",
    });
    byDoc.set(c.documentId, list);
  }

  let chunks = 0;
  for (const [documentId, docChunks] of byDoc) {
    await indexDocumentChunks(documentId, docChunks);
    chunks += docChunks.length;
  }
  return { documents: byDoc.size, chunks };
}
