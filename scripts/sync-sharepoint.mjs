#!/usr/bin/env node
/**
 * Drive the SharePoint → knowledge-base sync to completion.
 *
 * Calls POST /api/admin/sharepoint/sync repeatedly (each call processes a
 * bounded batch) until the server reports done. The first full load of a large
 * library runs over many batches; subsequent runs only pick up changes.
 *
 * Start the app + ensure the embeddings backend is reachable, then:
 *
 *   ADMIN_UPLOAD_TOKEN=... node scripts/sync-sharepoint.mjs
 *   CHAT_URL=https://norne.example.com ADMIN_UPLOAD_TOKEN=... MAX_FILES=100 \
 *     node scripts/sync-sharepoint.mjs
 *
 * Read-only against SharePoint; writes only to the app's local stores.
 */

const BASE = process.env.CHAT_URL ?? "http://localhost:3000";
const TOKEN = process.env.ADMIN_UPLOAD_TOKEN;
const MAX_FILES = Number.parseInt(process.env.MAX_FILES ?? "50", 10);

if (!TOKEN) {
  console.error("Set ADMIN_UPLOAD_TOKEN (the admin upload token) in the env.");
  process.exit(1);
}

let totals = { indexed: 0, removed: 0, skipped: 0 };
let batch = 0;

for (;;) {
  batch++;
  const res = await fetch(`${BASE}/api/admin/sharepoint/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ maxFiles: MAX_FILES }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Sync failed on batch ${batch} (HTTP ${res.status}):`, body);
    process.exit(1);
  }
  totals.indexed += body.indexed ?? 0;
  totals.removed += body.removed ?? 0;
  totals.skipped += body.skipped ?? 0;
  console.log(
    `batch ${batch}: +${body.indexed} indexed, ${body.removed} removed, ` +
      `${body.skipped} skipped` + (body.done ? " (done)" : ""),
  );
  if (body.done) break;
}

console.log(
  `Done. Total: ${totals.indexed} indexed, ${totals.removed} removed, ${totals.skipped} skipped.`,
);
