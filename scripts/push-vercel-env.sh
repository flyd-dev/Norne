#!/usr/bin/env bash
#
# push-vercel-env.sh — pusher miljøvariablene fra .env.local til Vercel.
#
# Bruk:
#   1) npx vercel@latest login      # logg inn (åpner nettleser) — engangs
#   2) npx vercel@latest link       # velg det eksisterende Norne-prosjektet
#   3) bash scripts/push-vercel-env.sh
#
# Scriptet leser verdiene fra .env.local, fjerner omsluttende hermetegn, og
# legger hver variabel inn for production + preview. FIREBASE_PRIVATE_KEY
# beholdes med literal \n (det er det koden i lib/env.ts forventer).
#
# Kjør med:  ONLY_PROD=1 bash scripts/push-vercel-env.sh   for kun production.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
VERCEL="npx vercel@latest"

# Variablene som skal pushes. Hold denne lista i sync med lib/env.ts.
VARS=(
  LLM_PROVIDER
  ANTHROPIC_API_KEY
  ANTHROPIC_MODEL
  OPENAI_API_KEY
  OPENAI_MODEL
  ASSISTANT_LLM_TOOL_CHOICE
  ADMIN_UPLOAD_TOKEN
  ENDRE_API_ENABLED
  FIREBASE_PROJECT_ID
  FIREBASE_CLIENT_EMAIL
  FIREBASE_PRIVATE_KEY
)

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Fant ikke $ENV_FILE" >&2
  exit 1
fi

if [[ ! -d "$ROOT/.vercel" ]]; then
  echo "Prosjektet er ikke linket. Kjør først:" >&2
  echo "  npx vercel@latest login && npx vercel@latest link" >&2
  exit 1
fi

if [[ "${ONLY_PROD:-0}" == "1" ]]; then
  TARGETS=(production)
else
  TARGETS=(production preview)
fi

# Leser én variabel fra .env.local og skriver ut råverdien med omsluttende
# hermetegn fjernet. Returnerer ikke-null hvis variabelen mangler/er tom.
read_env_value() {
  local name="$1"
  local line
  line="$(grep -E "^${name}=" "$ENV_FILE" | head -n1 || true)"
  [[ -z "$line" ]] && return 1
  local value="${line#*=}"
  # Fjern omsluttende doble eller enkle hermetegn (dotenv-syntaks, ikke verdi).
  if [[ "$value" == \"*\" ]]; then
    value="${value#\"}"; value="${value%\"}"
  elif [[ "$value" == \'*\' ]]; then
    value="${value#\'}"; value="${value%\'}"
  fi
  [[ -z "$value" ]] && return 1
  printf '%s' "$value"
}

for name in "${VARS[@]}"; do
  if ! value="$(read_env_value "$name")"; then
    echo "⏭  $name mangler eller er tom i .env.local — hopper over."
    continue
  fi
  for target in "${TARGETS[@]}"; do
    # Fjern eksisterende verdi (ignorer feil hvis den ikke finnes), legg så inn.
    $VERCEL env rm "$name" "$target" --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | $VERCEL env add "$name" "$target" >/dev/null
    echo "✅ $name → $target"
  done
done

echo
echo "Ferdig. Trigg en ny deploy så variablene tas i bruk:"
echo "  $VERCEL --prod"
