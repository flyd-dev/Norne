# Migrating from the VPS to Vercel

This app was built for a self-hosted VPS (local SQLite + JSON files, PM2, cron).
It can also run on Vercel by switching the storage backend to managed services —
**Turso** (libSQL) for vectors/chunks and **Firestore** for the small JSON
stores. Everything is behind env switches, so the VPS keeps working unchanged
until you cut over.

The code is done. What remains is provisioning (accounts + secrets) and the
cutover — steps only you can do, because they need credentials.

## Why no bespoke data-migration script

The knowledge base is **reconstructable from SharePoint** — it's the source of
truth, and the full sync re-extracts + re-embeds everything. So the "migration"
is simply: point a Vercel deployment (configured for the cloud backend) at
SharePoint and run the normal sync + dossier generation. No fragile copy of
local SQLite/JSON files is needed.

What is *not* carried over: the answer-feedback history (a handful of 👍/👎
ratings in `feedback.json`). It stays on the VPS. If you want it later, it can
be exported from `/admin/documents` and re-posted — low value, skipped here.

## 1. Provision the managed services

1. **Turso** (vectors): create a database at <https://turso.tech> (free tier is
   plenty for this corpus). Copy the **database URL** and an **auth token**.
2. **Firebase Admin SDK** (the JSON stores): the cloud backend writes via the
   Admin SDK, so you need a **service account** — Firebase Console → Project
   settings → Service accounts → *Generate new private key*. You'll set
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
   (REST/email-password mode is **not** enough for the cloud backend.)
3. **Vercel**: import the GitHub repo as a new Vercel project. You'll need the
   **Pro** plan for the 300s function duration the sync/dossier routes use.

## 2. Set environment variables on Vercel

Copy your existing secrets (LLM, embeddings, SharePoint, Endre, Firebase) plus:

```
STORE_BACKEND=cloud
VECTOR_BACKEND=turso
TURSO_DATABASE_URL=<from Turso>
TURSO_AUTH_TOKEN=<from Turso>

# Firebase Admin SDK (required for the cloud backend)
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="...\n...\n..."   # keep the \n escapes, wrap in quotes

# Embeddings: use a hosted provider (NOT ollama — there's no local Ollama on Vercel)
EMBEDDINGS_PROVIDER=openai            # or voyage
OPENAI_API_KEY=...

# Cron auth (Vercel sends this to /api/cron/sync automatically)
CRON_SECRET=<generate a long random string>

ADMIN_UPLOAD_TOKEN=<your admin token>
```

Do **not** set `DOCUMENT_STORE_PATH` / `VECTOR_STORE_PATH` / `DOSSIER_PATH` /
`SHAREPOINT_STATE_PATH` — those are the local backend only.

## 3. Deploy + populate the knowledge base

1. Deploy (push to the branch Vercel is tracking). The build must **not** import
   `better-sqlite3` — it won't, because `VECTOR_BACKEND=turso` lazy-loads only
   the Turso backend.
2. Full sync from SharePoint into Turso + Firestore (loops until done):
   ```bash
   CHAT_URL=https://<your-app>.vercel.app ADMIN_UPLOAD_TOKEN=<token> \
     node scripts/sync-sharepoint.mjs
   ```
3. Generate the case dossier:
   ```bash
   CHAT_URL=https://<your-app>.vercel.app ADMIN_UPLOAD_TOKEN=<token> \
     node scripts/generate-dossier.mjs
   ```

## 4. Verify, then cut over

- Ask the bot a few questions (a case question, a capacity question, a project
  lookup) and confirm answers + sources look right.
- Check the nightly cron: Vercel → project → Cron Jobs shows `/api/cron/sync` at
  03:00. It runs the SharePoint delta + regenerates the dossier when documents
  changed (the serverless equivalent of `scripts/nightly-update.sh`).
- Point your domain at the Vercel deployment.
- Decommission the VPS (PM2, the nightly crontab entry, the systemd unit) once
  you're satisfied.

## Rollback

Nothing about the VPS changed. To revert, just keep using it — its env still has
`STORE_BACKEND=local` (or unset). The cloud and local backends are independent.

## Notes / limitations

- **Firestore 1 MB/document limit**: each knowledge document is one Firestore
  doc (metadata + chunks). A single source file whose extracted text exceeds
  ~1 MB will fail to save with a clear error rather than truncating. None of the
  current corpus is close, but a very large scanned bundle could trip it — if so,
  that document would need splitting (or storing its chunks in a subcollection).
- **Reads**: `getAllChunks` / `getStructuredTables` read the whole document
  collection. That's fine here (semantic search is the primary path and uses
  Turso; these run on keyword fallback, dossier generation, and capacity
  questions). If the corpus grows a lot, add a dedicated structured-tables doc.
- **Cron coverage**: one nightly run drives the delta to completion within a
  ~220s budget; a very large *initial* backlog is better done with the manual
  sync script (step 3), which loops without a per-run cap.
