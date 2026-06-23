/**
 * Turso-backed persistence for the app's OWN state — the data that lives in
 * local JSON/SQLite files on the VPS but needs a hosted home on serverless
 * (Vercel). Selected via STORE_BACKEND=cloud; the "local" backend never imports
 * this module.
 *
 * Why Turso and not Firestore: the app's Firebase access is read-only REST mode
 * (no service account), and writes there would hit security rules. Turso is a
 * full SQL database we already use for vectors, with write access via the auth
 * token — so app state goes here, and Firebase stays exactly as-is for the
 * read-only DOMAIN data (accounts/projects, via lib/firestore/service.ts).
 *
 * Layout:
 *   app_kv(key TEXT PK, value TEXT)   -- single-doc state (dossier, sync cursor)
 *   kb_documents(...)                 -- one row per knowledge document
 *   feedback(...)                     -- one row per feedback record
 * (kb_documents and feedback are created by their own modules.)
 *
 * Server-side only.
 */

import "server-only";
import { getTursoClient } from "@/lib/turso/client";

let kvReady = false;

async function ensureKv() {
  const c = await getTursoClient();
  if (!kvReady) {
    await c.execute(
      "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    kvReady = true;
  }
  return c;
}

/** Read a single state document by key, or null when it doesn't exist. */
export async function readStateDoc<T>(key: string): Promise<T | null> {
  const c = await ensureKv();
  const res = await c.execute({
    sql: "SELECT value FROM app_kv WHERE key = ?",
    args: [key],
  });
  const value = res.rows[0]?.value;
  return value != null ? (JSON.parse(String(value)) as T) : null;
}

/** Write (upsert) a single state document by key. */
export async function writeStateDoc<T>(key: string, data: T): Promise<void> {
  const c = await ensureKv();
  await c.execute({
    sql: `INSERT INTO app_kv(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, JSON.stringify(data)],
  });
}
