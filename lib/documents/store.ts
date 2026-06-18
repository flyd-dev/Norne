/**
 * Firestore persistence for the document knowledge base.
 *
 *   knowledge_documents/{documentId}            -> metadata
 *   knowledge_documents/{documentId}/chunks/... -> chunks
 *
 * Backend-agnostic: uses the shared FirestoreClient (Admin SDK or REST). Only
 * extracted text/chunks are stored — never the original uploaded file.
 */

import "server-only";
import { getFirestoreClient } from "@/lib/firestore/client";
import type {
  DocumentChunk,
  DocumentRecord,
  StoredChunk,
} from "@/lib/documents/types";

const DOCS = "knowledge_documents";
const CHUNKS = "chunks";

/** Persist a document's metadata plus its chunks. */
export async function saveDocument(
  meta: {
    id: string;
    name: string;
    fileType: string;
    uploadedAt: string;
  },
  chunks: DocumentChunk[],
): Promise<void> {
  const client = getFirestoreClient();
  await client.createDocument(DOCS, meta.id, {
    name: meta.name,
    fileType: meta.fileType,
    uploadedAt: meta.uploadedAt,
    chunkCount: chunks.length,
  });
  await client.createSubDocuments(
    DOCS,
    meta.id,
    CHUNKS,
    chunks.map((chunk) => ({
      // zero-padded so chunks list in order
      id: String(chunk.chunkIndex).padStart(6, "0"),
      data: { ...chunk },
    })),
  );
}

/** List all knowledge documents (metadata only). */
export async function listDocuments(): Promise<DocumentRecord[]> {
  const docs = await getFirestoreClient().listCollection(DOCS);
  return docs
    .map((d) => ({
      id: d.id,
      name: String(d.name ?? ""),
      fileType: String(d.fileType ?? ""),
      uploadedAt: String(d.uploadedAt ?? ""),
      chunkCount: Number(d.chunkCount ?? 0),
    }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** Delete a document and all of its chunks. */
export async function deleteDocument(id: string): Promise<void> {
  await getFirestoreClient().deleteDocumentWithSubcollection(DOCS, id, CHUNKS);
}

/**
 * Load every stored chunk across all documents (for keyword search).
 * Iterates documents then their chunks — works on any backend. Fine for MVP
 * volumes; replace with a vector index for scale.
 */
export async function getAllChunks(): Promise<StoredChunk[]> {
  const client = getFirestoreClient();
  const docs = await client.listCollection(DOCS);
  const all: StoredChunk[] = [];
  for (const doc of docs) {
    const chunks = await client.listSubcollection(DOCS, doc.id, CHUNKS);
    for (const c of chunks) {
      all.push({
        documentId: String(c.documentId ?? doc.id),
        documentName: String(c.documentName ?? doc.name ?? ""),
        fileType: String(c.fileType ?? doc.fileType ?? ""),
        sheetName: c.sheetName == null ? undefined : String(c.sheetName),
        chunkIndex: Number(c.chunkIndex ?? 0),
        text: String(c.text ?? ""),
      });
    }
  }
  return all;
}
