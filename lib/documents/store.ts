/**
 * Persistence for the document knowledge base (metadata + extracted chunks +
 * structured tables). Only extracted text is stored; the original uploaded file
 * is never persisted.
 *
 * Backend selected by STORE_BACKEND:
 *   - "local" (default): a single JSON file on the server (DOCUMENT_STORE_PATH,
 *     default /var/lib/norne-chatbot/knowledge-documents.json). NOT Firestore.
 *   - "cloud": one Firestore document per knowledge document (serverless /
 *     Vercel), in the norne_knowledge_documents collection.
 *
 * (Domain Firestore — accounts/projects — is unrelated and read via
 * lib/firestore/service.ts.)
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

function useCloud(): boolean {
  return env.storeBackend() === "cloud";
}

// --- Cloud (Firestore) backend -------------------------------------------
// One Firestore document per knowledge document. Firestore caps a document at
// ~1 MB, so a single source file whose extracted chunks exceed that will throw
// a clear error on save rather than truncating silently.
const FIRESTORE_DOC_LIMIT_BYTES = 1_000_000;

async function cloudCollection() {
  const { getAdminFirestore } = await import("@/lib/firebaseAdmin");
  const { APP_COLLECTIONS } = await import("@/lib/firestore/appStore");
  return getAdminFirestore().collection(APP_COLLECTIONS.documents);
}

async function readAllCloudDocuments(): Promise<StoredDocument[]> {
  const snap = await (await cloudCollection()).get();
  return snap.docs.map((d) => d.data() as StoredDocument);
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
  const doc: StoredDocument = {
    id: meta.id,
    name: meta.name,
    fileType: meta.fileType,
    uploadedAt: meta.uploadedAt,
    chunkCount: chunks.length,
    chunks,
    ...(structured && structured.length > 0 ? { structured } : {}),
  };

  if (useCloud()) {
    const size = Buffer.byteLength(JSON.stringify(doc), "utf8");
    if (size > FIRESTORE_DOC_LIMIT_BYTES) {
      throw new Error(
        `Document "${meta.name}" is ${(size / 1e6).toFixed(2)} MB of extracted ` +
          `text — over Firestore's ~1 MB per-document limit. Cannot store it in ` +
          `the cloud backend.`,
      );
    }
    await (await cloudCollection()).doc(meta.id).set(doc);
    return;
  }

  await withLock(async () => {
    const store = await readStore();
    const documents = store.documents.filter((d) => d.id !== meta.id);
    documents.push(doc);
    await writeStore({ documents });
  });
}

/** List all knowledge documents (metadata only), newest first. */
export async function listDocuments(): Promise<DocumentRecord[]> {
  const documents = useCloud()
    ? await readAllCloudDocuments()
    : (await readStore()).documents;
  return documents
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
  if (useCloud()) {
    await (await cloudCollection()).doc(id).delete();
    return;
  }
  await withLock(async () => {
    const store = await readStore();
    const documents = store.documents.filter((d) => d.id !== id);
    await writeStore({ documents });
  });
}

/** Load every stored structured staffing/capacity table across all documents. */
export async function getStructuredTables(): Promise<StoredStructuredTable[]> {
  const documents = useCloud()
    ? await readAllCloudDocuments()
    : (await readStore()).documents;
  const all: StoredStructuredTable[] = [];
  for (const doc of documents) {
    for (const table of doc.structured ?? []) {
      all.push({ ...table, documentId: doc.id, documentName: doc.name });
    }
  }
  return all;
}

/**
 * Canonical capacity rows across all uploaded documents: the structured
 * staffing tables normalized to CapacityRow (ISO month, per fag). This is the
 * "structured at ingestion" accessor — capacity questions read this instead of
 * re-parsing month wording at query time.
 */
export async function getCapacityRows(): Promise<
  import("@/lib/assistant/domain/capacity").CapacityRow[]
> {
  const { capacityRowsFromTables } = await import(
    "@/lib/assistant/ingestion/capacity"
  );
  return capacityRowsFromTables(await getStructuredTables());
}

/** Load every stored chunk across all documents (for keyword search). */
export async function getAllChunks(): Promise<StoredChunk[]> {
  const documents = useCloud()
    ? await readAllCloudDocuments()
    : (await readStore()).documents;
  const all: StoredChunk[] = [];
  for (const doc of documents) {
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
