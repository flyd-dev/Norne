#!/usr/bin/env node
/**
 * Backfill the semantic (vector) index from documents already in the JSON store.
 *
 * Start the app first (npm run dev / running on the VPS), ensure the embeddings
 * backend is reachable (Ollama with the model pulled, or OpenAI), then run:
 *
 *   ADMIN_UPLOAD_TOKEN=... node scripts/reindex-documents.mjs
 *   CHAT_URL=https://norne.example.com ADMIN_UPLOAD_TOKEN=... node scripts/reindex-documents.mjs
 *
 * Idempotent: safe to re-run. Reads no document contents locally — it just
 * triggers the in-app reindex route, which does the embedding server-side.
 */

const BASE = process.env.CHAT_URL ?? "http://localhost:3000";
const TOKEN = process.env.ADMIN_UPLOAD_TOKEN;

if (!TOKEN) {
  console.error("Set ADMIN_UPLOAD_TOKEN (the admin upload token) in the env.");
  process.exit(1);
}

const res = await fetch(`${BASE}/api/admin/documents/reindex`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}` },
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Reindex failed (HTTP ${res.status}):`, body);
  process.exit(1);
}
console.log(`Reindexed ${body.documents} document(s), ${body.chunks} chunk(s).`);
