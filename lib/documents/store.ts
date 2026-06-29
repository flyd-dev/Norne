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

// --- Cloud (Turso) backend ------------------------------------------------
// One row per knowledge document in the kb_documents table; chunks + structured
// tables are stored as JSON text columns. No per-row size limit to worry about
// (unlike Firestore's ~1 MB/doc), and writes use the Turso auth token.
let kbReady = false;

async function kbTable() {
  const { getTursoClient } = await import("@/lib/turso/client");
  const c = await getTursoClient();
  if (!kbReady) {
    await c.execute(
      `CREATE TABLE IF NOT EXISTS kb_documents (
         id          TEXT PRIMARY KEY,
         name        TEXT NOT NULL,
         fileType    TEXT NOT NULL,
         uploadedAt  TEXT NOT NULL,
         chunkCount  INTEGER NOT NULL,
         chunks      TEXT NOT NULL,
         structured  TEXT
       )`,
    );
    kbReady = true;
  }
  return c;
}

/** Document metadata only (no chunk text) — small, fast, reliable. */
type CloudDocMeta = Omit<StoredDocument, "chunks" | "structured">;

async function readCloudDocMeta(): Promise<CloudDocMeta[]> {
  const c = await kbTable();
  const res = await c.execute(
    "SELECT id, name, fileType, uploadedAt, chunkCount FROM kb_documents",
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    fileType: String(r.fileType),
    uploadedAt: String(r.uploadedAt),
    chunkCount: Number(r.chunkCount),
  }));
}

/** Full record (chunks + structured) for ONE cloud document. */
async function readCloudDocument(id: string): Promise<StoredDocument | null> {
  const c = await kbTable();
  const res = await c.execute({
    sql: "SELECT id, name, fileType, uploadedAt, chunkCount, chunks, structured FROM kb_documents WHERE id = ?",
    args: [id],
  });
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    fileType: String(r.fileType),
    uploadedAt: String(r.uploadedAt),
    chunkCount: Number(r.chunkCount),
    chunks: JSON.parse(String(r.chunks)) as DocumentChunk[],
    ...(r.structured != null
      ? { structured: JSON.parse(String(r.structured)) as StructuredTable[] }
      : {}),
  };
}

/**
 * Full records for every cloud document, fetched PER DOCUMENT so no single query
 * has to return the entire corpus's chunk text at once. A single
 * `SELECT *, chunks FROM kb_documents` returns several MB across ~thousands of
 * chunks and is slow/unreliable in a serverless function (observed: 256s then an
 * empty result, blocking dossier generation). One bounded query per document is
 * reliable; the per-doc responses run concurrently.
 */
async function readAllCloudDocuments(): Promise<StoredDocument[]> {
  const meta = await readCloudDocMeta();
  const docs = await Promise.all(meta.map((m) => readCloudDocument(m.id)));
  return docs.filter((d): d is StoredDocument => d !== null);
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
    const c = await kbTable();
    await c.execute({
      sql: `INSERT INTO kb_documents(id, name, fileType, uploadedAt, chunkCount, chunks, structured)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, fileType = excluded.fileType,
              uploadedAt = excluded.uploadedAt, chunkCount = excluded.chunkCount,
              chunks = excluded.chunks, structured = excluded.structured`,
      args: [
        doc.id,
        doc.name,
        doc.fileType,
        doc.uploadedAt,
        doc.chunkCount,
        JSON.stringify(doc.chunks),
        doc.structured && doc.structured.length > 0
          ? JSON.stringify(doc.structured)
          : null,
      ],
    });
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
  // Metadata only — never load chunk text just to list documents.
  const documents = useCloud()
    ? await readCloudDocMeta()
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
    const c = await kbTable();
    await c.execute({ sql: "DELETE FROM kb_documents WHERE id = ?", args: [id] });
    return;
  }
  await withLock(async () => {
    const store = await readStore();
    const documents = store.documents.filter((d) => d.id !== id);
    await writeStore({ documents });
  });
}

/** id/name/structured for cloud docs that have structured tables (skips the
 * heavy chunk text — capacity questions only need the structured tables). */
async function readCloudStructured(): Promise<
  Pick<StoredDocument, "id" | "name" | "structured">[]
> {
  const c = await kbTable();
  const res = await c.execute(
    "SELECT id, name, structured FROM kb_documents WHERE structured IS NOT NULL",
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    structured:
      r.structured != null
        ? (JSON.parse(String(r.structured)) as StructuredTable[])
        : undefined,
  }));
}

/** Load every stored structured staffing/capacity table across all documents. */
export async function getStructuredTables(): Promise<StoredStructuredTable[]> {
  // Only the structured column is needed — don't pull every chunk's text.
  const documents = useCloud()
    ? await readCloudStructured()
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
