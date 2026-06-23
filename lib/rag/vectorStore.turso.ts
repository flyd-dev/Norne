/**
 * Turso (libSQL) vector backend — managed, serverless-friendly retrieval store
 * used on Vercel. Behind the VECTOR_BACKEND="turso" selector in the vectorStore
 * facade. Talks to Turso over HTTP via @libsql/client, so there is no native
 * build and no local filesystem (unlike the sqlite backend).
 *
 * libSQL has native vector support. Embeddings are stored in an F32_BLOB(dim)
 * column via vector32(), and KNN search uses vector_distance_cos() with an
 * ORDER BY … LIMIT brute-force scan. For this corpus (a few thousand chunks) a
 * full cosine scan is fast and avoids the ANN-index DDL; switch to
 * libsql_vector_idx + vector_top_k() if the corpus grows by orders of magnitude.
 *
 * Schema mirrors the sqlite backend:
 *   chunks(id INTEGER PK, documentId, documentName, fileType, sheetName,
 *          chunkIndex, text, embedding F32_BLOB(dim))
 *   vec_meta(key, value)   -- stores the embedding dimension
 *
 * Server-side only.
 */

import "server-only";
import {
  closeTursoClient,
  getTursoClient,
} from "@/lib/turso/client";
import type {
  UpsertChunk,
  VectorBackend,
  VectorMatch,
} from "@/lib/rag/vectorStore";
import type { Client } from "@libsql/client";

export function createTursoVectorStore(): VectorBackend {
  let baseSchemaReady = false;

  async function getClient(): Promise<Client> {
    return getTursoClient();
  }

  /** Create the metadata table (idempotent). The chunks table needs the
   * embedding dimension, so it is created lazily in ensureChunksTable(). */
  async function ensureBaseSchema(c: Client): Promise<void> {
    if (baseSchemaReady) return;
    await c.execute(
      "CREATE TABLE IF NOT EXISTS vec_meta (key TEXT PRIMARY KEY, value TEXT)",
    );
    baseSchemaReady = true;
  }

  async function readDim(c: Client): Promise<number | null> {
    await ensureBaseSchema(c);
    const res = await c.execute({
      sql: "SELECT value FROM vec_meta WHERE key = 'dim'",
      args: [],
    });
    const value = res.rows[0]?.value;
    return value != null ? Number.parseInt(String(value), 10) : null;
  }

  /**
   * Create the chunks table for a given embedding dimension (idempotent).
   * Throws if a different dimension was already initialised — changing embedding
   * models means the index must be rebuilt from scratch (drop the tables).
   */
  async function ensureChunksTable(c: Client, dim: number): Promise<void> {
    const existing = await readDim(c);
    if (existing !== null) {
      if (existing !== dim) {
        throw new Error(
          `Vector store was built with embedding dimension ${existing}, but the ` +
            `current model produces ${dim}. Drop the Turso chunks/vec_meta tables ` +
            `and re-index after changing the embedding model.`,
        );
      }
      return;
    }
    await c.batch([
      `CREATE TABLE IF NOT EXISTS chunks (
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         documentId   TEXT NOT NULL,
         documentName TEXT NOT NULL,
         fileType     TEXT NOT NULL,
         sheetName    TEXT,
         chunkIndex   INTEGER NOT NULL,
         text         TEXT NOT NULL,
         embedding    F32_BLOB(${dim}) NOT NULL
       )`,
      "CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(documentId)",
      {
        sql: "INSERT OR REPLACE INTO vec_meta(key, value) VALUES ('dim', ?)",
        args: [String(dim)],
      },
    ]);
  }

  /** True once the chunks table exists (dim recorded). */
  async function chunksTableExists(c: Client): Promise<boolean> {
    return (await readDim(c)) !== null;
  }

  return {
    async ensureVectorStore(): Promise<void> {
      await ensureBaseSchema(await getClient());
    },

    async vectorCount(): Promise<number> {
      try {
        const c = await getClient();
        if (!(await chunksTableExists(c))) return 0;
        const res = await c.execute("SELECT COUNT(*) AS n FROM chunks");
        return Number(res.rows[0]?.n ?? 0);
      } catch {
        return 0;
      }
    },

    async deleteDocumentVectors(documentId: string): Promise<void> {
      const c = await getClient();
      if (!(await chunksTableExists(c))) return;
      await c.execute({
        sql: "DELETE FROM chunks WHERE documentId = ?",
        args: [documentId],
      });
    },

    async upsertDocumentChunks(
      documentId: string,
      chunks: UpsertChunk[],
      embeddings: number[][],
    ): Promise<void> {
      if (chunks.length !== embeddings.length) {
        throw new Error("chunks and embeddings length mismatch.");
      }
      const c = await getClient();
      if (chunks.length === 0) {
        if (await chunksTableExists(c)) {
          await c.execute({
            sql: "DELETE FROM chunks WHERE documentId = ?",
            args: [documentId],
          });
        }
        return;
      }
      await ensureChunksTable(c, embeddings[0].length);

      // Replace semantics: delete the old version, then insert the new chunks —
      // all in one batch so the document is never left half-written.
      const statements: Parameters<Client["batch"]>[0] = [
        {
          sql: "DELETE FROM chunks WHERE documentId = ?",
          args: [documentId],
        },
      ];
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        statements.push({
          sql: `INSERT INTO chunks(documentId, documentName, fileType, sheetName, chunkIndex, text, embedding)
                VALUES (?, ?, ?, ?, ?, ?, vector32(?))`,
          args: [
            ch.documentId,
            ch.documentName,
            ch.fileType,
            ch.sheetName ?? null,
            ch.chunkIndex,
            ch.text,
            JSON.stringify(embeddings[i]),
          ],
        });
      }
      await c.batch(statements, "write");
    },

    async searchVectors(
      queryEmbedding: number[],
      limit: number,
    ): Promise<VectorMatch[]> {
      const c = await getClient();
      if (!(await chunksTableExists(c))) return [];
      const res = await c.execute({
        sql: `SELECT documentId, documentName, fileType, sheetName, chunkIndex, text,
                     vector_distance_cos(embedding, vector32(?)) AS distance
                FROM chunks
               ORDER BY distance ASC
               LIMIT ?`,
        args: [JSON.stringify(queryEmbedding), limit],
      });

      return res.rows.map((r) => {
        const distance = Number(r.distance);
        return {
          documentId: String(r.documentId),
          documentName: String(r.documentName),
          fileType: String(r.fileType),
          sheetName: r.sheetName != null ? String(r.sheetName) : undefined,
          chunkIndex: Number(r.chunkIndex),
          text: String(r.text),
          distance,
          // vector_distance_cos returns cosine distance (1 - cosineSim).
          similarity: 1 - distance,
        };
      });
    },

    async closeVectorStore(): Promise<void> {
      baseSchemaReady = false;
      closeTursoClient();
    },
  };
}
