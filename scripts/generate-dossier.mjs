#!/usr/bin/env node
/**
 * (Re)generate the case dossier — a structured overview of the whole case,
 * synthesised from every indexed document and injected on case questions.
 *
 * Run after a sync so the dossier reflects the latest documents:
 *
 *   ADMIN_UPLOAD_TOKEN=... node scripts/generate-dossier.mjs
 *   CHAT_URL=http://187.77.85.84:3000 ADMIN_UPLOAD_TOKEN=... node scripts/generate-dossier.mjs
 *
 * Makes one LLM call over document excerpts (can take a minute or so).
 */

const BASE = process.env.CHAT_URL ?? "http://localhost:3000";
const TOKEN = process.env.ADMIN_UPLOAD_TOKEN;

if (!TOKEN) {
  console.error("Set ADMIN_UPLOAD_TOKEN (the admin upload token) in the env.");
  process.exit(1);
}

const res = await fetch(`${BASE}/api/admin/dossier`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Dossier generation failed (HTTP ${res.status}):`, body);
  process.exit(1);
}
console.log(
  `Dossier generated from ${body.documentCount} document(s) ` +
    `(${body.length} chars) at ${body.generatedAt}.`,
);
