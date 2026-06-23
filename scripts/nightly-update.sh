#!/usr/bin/env bash
#
# Nightly knowledge-base refresh.
#
# Runs the SharePoint delta sync, then — only if the sync actually changed the
# corpus — regenerates the case dossier so the bot's resident case knowledge
# stays current. Point the 03:00 crontab entry at THIS script instead of calling
# the sync script directly:
#
#   0 3 * * * cd /var/www/norne-chatbot && \
#     CHAT_URL=http://187.77.85.84:3000 ADMIN_UPLOAD_TOKEN=<token> \
#     ./scripts/nightly-update.sh >> /var/log/norne-nightly.log 2>&1
#
# CHAT_URL and ADMIN_UPLOAD_TOKEN are inherited from the environment (set them in
# the crontab line, as above). Read-only against SharePoint; writes only to the
# app's local stores + the dossier file.

set -uo pipefail

cd "$(dirname "$0")/.."

echo "[$(date -Is)] nightly: starting SharePoint delta sync"
sync_output="$(node scripts/sync-sharepoint.mjs)"
sync_rc=$?
echo "$sync_output"

if [ "$sync_rc" -ne 0 ]; then
  echo "[$(date -Is)] nightly: sync failed (rc=$sync_rc) — skipping dossier regeneration"
  exit "$sync_rc"
fi

# The sync script prints "Done. Total: <n> indexed, <m> removed, ..." — only a
# non-zero indexed/removed count means documents changed and the dossier is now
# stale. Skip the (LLM-cost) regeneration when nothing changed.
if echo "$sync_output" | grep -qE 'Total: 0 indexed, 0 removed'; then
  echo "[$(date -Is)] nightly: no document changes — skipping dossier regeneration"
else
  echo "[$(date -Is)] nightly: documents changed — regenerating case dossier"
  node scripts/generate-dossier.mjs
fi

echo "[$(date -Is)] nightly: done"
