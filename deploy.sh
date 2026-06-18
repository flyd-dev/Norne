#!/usr/bin/env bash
#
# Deploy the latest main to this server. Run from the app directory on the VPS:
#   ./deploy.sh
#
# Pulls main, installs deps, rebuilds the Next.js production bundle and restarts
# the process. Stops on the first error so a failed build never restarts a broken
# app. Override the PM2 app name with:  APP_NAME=my-app ./deploy.sh
#
# NOTE: this does NOT re-upload documents. After a parser change, re-upload the
# affected files via /admin/documents (the structured parse is cached at upload).
set -euo pipefail

APP_NAME="${APP_NAME:-norne-chatbot}"

echo "==> git pull origin main"
git pull origin main

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

echo "==> restart ($APP_NAME)"
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME"
  pm2 save
elif systemctl list-units --type=service 2>/dev/null | grep -q "$APP_NAME"; then
  sudo systemctl restart "$APP_NAME"
else
  echo "!! Fant ikke prosessen '$APP_NAME' i PM2 eller systemd."
  echo "   Restart manuelt, eller sett APP_NAME=<navn> ./deploy.sh"
  exit 1
fi

echo "==> ferdig. Husk: slett + last opp endrede dokumenter på /admin/documents."
