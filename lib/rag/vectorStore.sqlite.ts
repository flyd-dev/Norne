/**
 * SQLite (sqlite-vec) vector backend — the local, on-disk retrieval store used
 * on the VPS. Behind the VECTOR_BACKEND="sqlite" selector in the vectorStore
 * facade. better-sqlite3 + sqlite-vec are native; this module is lazy-loaded by
 * the facade so they never compile/import on serverless (Turso) deployments.
 *
 * Why not the JSON store: lib/documents/store.ts loads EVERY chunk into memory on
 * every query, which is fine for a handful of uploads but collapses on a large
 * corpus (e.g. a synced SharePoint library). sqlite-vec runs an approximate KNN
 * search on disk, so retrieval stays fast and bounded regardless of corpus size,
 * while remaining a single local file on the server.
 *
 * Schema:
 *   chunks(id INTEGER PK, documentId, documentName, fileType, sheetName,
 *          chunkIndex, text)             -- chunk metadata + text
 *   chunk_vectors USING vec0(embedding float[DIM])  -- shares rowid with chunks
 *   vec_meta(key, value)                 -- stores the embedding dimension
 *
 * Server-side only. The exported methods are async to match the VectorBackend
 * interface; the underlying sqlite-vec calls are synchronous.
 */

import "server-only";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { env } from "@/lib/env";
import type {
  UpsertChunk,
  VectorBackend,
  VectorMatch,
} from "@/lib/rag/vectorStore";

type Db = Database.Database;

export function createSqliteVectorStore(): VectorBackend {
  let db: Db | null = null;

  function open(): Db {
    if (db) return db;
    const path = env.rag.vectorStorePath();
    const handle = new Database(path);
    sqliteVec.load(handle);
    handle.pragma("journal_mode = WAL");
    handle.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        documentId  TEXT NOT NULL,
        documentName TEXT NOT NULL,
        fileType    TEXT NOT NULL,
        sheetName   TEXT,
        chunkIndex  INTEGER NOT NULL,
        text        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(documentId);
      CREATE TABLE IF NOT EXISTS vec_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    db = handle;
    return handle;
  }

  function readDim(handle: Db): number | null {
    const row = handle
      .prepare("SELECT value FROM vec_meta WHERE key = 'dim'")
      .get() as { value?: string } | undefined;
    return row?.value ? Number.parseInt(row.value, 10) : null;
  }

  /**
   * Create the vector virtual table for a given embedding dimension (idempotent).
   * Throws if a different dimension was already initialised — changing embedding
   * models means the index must be rebuilt from scratch (delete the .db file).
   */
  function ensureVecTable(handle: Db, dim: number): void {
    const existing = readDim(handle);
    if (existing !== null) {
      if (existing !== dim) {
        throw new Error(
          `Vector store was built with embedding dimension ${existing}, but the ` +
            `current model produces ${dim}. Delete ${env.rag.vectorStorePath()} ` +
            `and re-index after changing the embedding model.`,
        );
      }
      return;
    }
    handle.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(embedding float[${dim}])`,
    );
    handle
      .prepare("INSERT OR REPLACE INTO vec_meta(key, value) VALUES ('dim', ?)")
      .run(String(dim));
  }

  function deleteVectorsSync(documentId: string): void {
    const handle = open();
    if (readDim(handle) === null) return;
    const ids = handle
      .prepare("SELECT id FROM chunks WHERE documentId = ?")
      .all(documentId) as { id: number }[];
    if (ids.length === 0) return;
    const delVec = handle.prepare("DELETE FROM chunk_vectors WHERE rowid = ?");
    const delChunk = handle.prepare("DELETE FROM chunks WHERE id = ?");
    const tx = handle.transaction((rows: { id: number }[]) => {
      for (const { id } of rows) {
        delVec.run(BigInt(id));
        delChunk.run(id);
      }
    });
    tx(ids);
  }

  return {
    async ensureVectorStore(): Promise<void> {
      await mkdir(dirname(env.rag.vectorStorePath()), { recursive: true });
      open();
    },

    async vectorCount(): Promise<number> {
      try {
        const handle = open();
        if (readDim(handle) === null) return 0;
        const row = handle.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
          n: number;
        };
        return row.n;
      } catch {
        return 0;
      }
    },

    async deleteDocumentVectors(documentId: string): Promise<void> {
      deleteVectorsSync(documentId);
    },

    async upsertDocumentChunks(
      documentId: string,
      chunks: UpsertChunk[],
      embeddings: number[][],
    ): Promise<void> {
      if (chunks.length !== embeddings.length) {
        throw new Error("chunks and embeddings length mismatch.");
      }
      const handle = open();
      if (chunks.length === 0) {
        deleteVectorsSync(documentId);
        return;
      }
      ensureVecTable(handle, embeddings[0].length);

      const insChunk = handle.prepare(
        `INSERT INTO chunks(documentId, documentName, fileType, sheetName, chunkIndex, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insVec = handle.prepare(
        "INSERT INTO chunk_vectors(rowid, embedding) VALUES (?, vec_f32(?))",
      );

      const tx = handle.transaction(() => {
        // Replace semantics: clear the old version first.
        const old = handle
          .prepare("SELECT id FROM chunks WHERE documentId = ?")
          .all(documentId) as { id: number }[];
        const delVec = handle.prepare("DELETE FROM chunk_vectors WHERE rowid = ?");
        const delChunk = handle.prepare("DELETE FROM chunks WHERE id = ?");
        for (const { id } of old) {
          delVec.run(BigInt(id));
          delChunk.run(id);
        }
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          const info = insChunk.run(
            c.documentId,
            c.documentName,
            c.fileType,
            c.sheetName ?? null,
            c.chunkIndex,
            c.text,
          );
          insVec.run(
            BigInt(info.lastInsertRowid as number),
            JSON.stringify(embeddings[i]),
          );
        }
      });
      tx();
    },

    async searchVectors(
      queryEmbedding: number[],
      limit: number,
    ): Promise<VectorMatch[]> {
      const handle = open();
      if (readDim(handle) === null) return [];
      const rows = handle
        .prepare(
          `SELECT c.documentId, c.documentName, c.fileType, c.sheetName,
                  c.chunkIndex, c.text, v.distance AS distance
             FROM chunk_vectors v
             JOIN chunks c ON c.id = v.rowid
            WHERE v.embedding MATCH vec_f32(?) AND k = ?
            ORDER BY v.distance`,
        )
        .all(JSON.stringify(queryEmbedding), limit) as Array<{
        documentId: string;
        documentName: string;
        fileType: string;
        sheetName: string | null;
        chunkIndex: number;
        text: string;
        distance: number;
      }>;

      return rows.map((r) => ({
        documentId: r.documentId,
        documentName: r.documentName,
        fileType: r.fileType,
        sheetName: r.sheetName ?? undefined,
        chunkIndex: r.chunkIndex,
        text: r.text,
        distance: r.distance,
        // Unit vectors: L2² = 2 - 2·cos ⇒ cosineSim = 1 - d²/2.
        similarity: 1 - (r.distance * r.distance) / 2,
      }));
    },

    async closeVectorStore(): Promise<void> {
      if (db) {
        db.close();
        db = null;
      }
    },
  };
}
