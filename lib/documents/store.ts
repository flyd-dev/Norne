/**
 * Local filesystem persistence for the document knowledge base.
 *
 * Uploaded documents are stored as a single JSON file on the server
 * (DOCUMENT_STORE_PATH, default /var/lib/norne-chatbot/knowledge-documents.json)
 * — NOT in Firestore. Firestore remains in use only for project data.
 *
 * Only extracted text/chunks are stored; the original uploaded file is never
 * persisted. The store directory is created automatically if missing.
 */

import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "@/lib/env";
import type {
  DocumentChunk,
  DocumentRecord,
  StoredChunk,
  StoredStructuredTable,
  StructuredTable,
} from "@/lib/documents/types";

interface StoredDocument {
  id: string;
  name: string;
  fileType: string;
  uploadedAt: string;
  chunkCount: number;
  chunks: DocumentChunk[];
  /** Best-effort structured staffing/capacity tables (XLSX only). */
  structured?: StructuredTable[];
}

interface StoreFile {
  documents: StoredDocument[];
}

function storePath(): string {
  return env.documents.storePath();
}

async function readStore(): Promise<StoreFile> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || !Array.isArray(parsed.documents)) return { documents: [] };
    return parsed;
  } catch (error) {
    // Missing file → empty store (first run).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { documents: [] };
    }
    throw error;
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  // Write to a temp file then rename for an atomic replace.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await rename(tmp, path);
}

// Serialize read-modify-write operations to avoid clobbering on concurrent
// uploads/deletes (single-process demo scope).
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** True for filesystem permission/read-only errors (clear admin messaging). */
export function isFilesystemPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/** Persist a document's metadata plus its chunks (replacing any with same id). */
export async function saveDocument(
  meta: { id: string; name: string; fileType: string; uploadedAt: string },
  chunks: DocumentChunk[],
  structured?: StructuredTable[],
): Promise<void> {
  await withLock(async () => {
    const store = await readStore();
    const documents = store.documents.filter((d) => d.id !== meta.id);
    documents.push({
      id: meta.id,
      name: meta.name,
      fileType: meta.fileType,
      uploadedAt: meta.uploadedAt,
      chunkCount: chunks.length,
      chunks,
      ...(structured && structured.length > 0 ? { structured } : {}),
    });
    await writeStore({ documents });
  });
}

/** List all knowledge documents (metadata only), newest first. */
export async function listDocuments(): Promise<DocumentRecord[]> {
  const store = await readStore();
  return store.documents
    .map((d) => ({
      id: d.id,
      name: d.name,
      fileType: d.fileType,
      uploadedAt: d.uploadedAt,
      chunkCount: d.chunkCount,
    }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** Delete a document and its chunks. */
export async function deleteDocument(id: string): Promise<void> {
  await withLock(async () => {
    const store = await readStore();
    const documents = store.documents.filter((d) => d.id !== id);
    await writeStore({ documents });
  });
}

/** Load every stored structured staffing/capacity table across all documents. */
export async function getStructuredTables(): Promise<StoredStructuredTable[]> {
  const store = await readStore();
  const all: StoredStructuredTable[] = [];
  for (const doc of store.documents) {
    for (const table of doc.structured ?? []) {
      all.push({ ...table, documentId: doc.id, documentName: doc.name });
    }
  }
  return all;
}

/** Load every stored chunk across all documents (for keyword search). */
export async function getAllChunks(): Promise<StoredChunk[]> {
  const store = await readStore();
  const all: StoredChunk[] = [];
  for (const doc of store.documents) {
    for (const c of doc.chunks) {
      all.push({
        documentId: c.documentId,
        documentName: c.documentName,
        fileType: c.fileType,
        sheetName: c.sheetName ?? undefined,
        chunkIndex: c.chunkIndex,
        text: c.text,
      });
    }
  }
  return all;
}
