/**
 * Centralised, server-only access to environment variables + validation.
 *
 * Nothing here is exported to the browser: this module is only imported from
 * server-side code (API routes, services). Do NOT prefix any of these with
 * NEXT_PUBLIC_ — that would expose them to the client bundle.
 *
 * Error messages list variable NAMES only — never values — so misconfiguration
 * can be diagnosed without leaking secrets.
 */

import "server-only";
import { SUPPORTED_LLM_PROVIDERS, type LlmProvider } from "@/lib/llm/types";

function readOptional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function requireVar(name: string): string {
  const value = readOptional(name);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export const env = {
  llm: {
    /** Selected provider; defaults to "anthropic", unknown values fall back to it. */
    provider: (): LlmProvider => {
      const raw = (readOptional("LLM_PROVIDER") ?? "anthropic").toLowerCase();
      return (SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(raw)
        ? (raw as LlmProvider)
        : "anthropic";
    },
  },
  anthropic: {
    apiKey: () => requireVar("ANTHROPIC_API_KEY"),
    // Optional. Defaults to claude-sonnet-4-6 if unset. Used by the deterministic
    // pipeline's single-shot answer generation.
    model: () => readOptional("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6",
    // Model for the agentic reasoning loop (tool-calling). Defaults to the most
    // capable Opus tier so the bot reasons over the data like a full chat model;
    // override with ANTHROPIC_AGENT_MODEL if needed.
    agentModel: () => readOptional("ANTHROPIC_AGENT_MODEL") ?? "claude-opus-4-8",
  },
  openai: {
    apiKey: () => requireVar("OPENAI_API_KEY"),
    model: () => readOptional("OPENAI_MODEL") ?? "gpt-4o-mini",
  },
  ollama: {
    baseUrl: () => readOptional("OLLAMA_BASE_URL") ?? "http://localhost:11434",
    model: () => requireVar("OLLAMA_MODEL"),
    // Optional: only needed when the Ollama endpoint is behind bearer auth
    // (e.g. a reverse proxy on a remote VPS). Local Ollama usually has no auth.
    apiKey: () => readOptional("OLLAMA_API_KEY"),
  },
  voyage: {
    // Voyage AI — Anthropic's recommended embeddings provider (Anthropic has no
    // embeddings API of its own). Generous free tier; hosted, nothing to install.
    apiKey: () => requireVar("VOYAGE_API_KEY"),
    baseUrl: () =>
      readOptional("VOYAGE_BASE_URL") ?? "https://api.voyageai.com/v1",
  },
  admin: {
    // Token gating the document-upload admin routes. Optional: if unset, the
    // admin routes are disabled (not the chatbot). Never sent to the browser.
    uploadToken: () => readOptional("ADMIN_UPLOAD_TOKEN"),
  },
  cron: {
    // Secret for the scheduled cron route (/api/cron/sync). On Vercel, set this
    // env var and Vercel Cron sends it automatically as a Bearer token; the
    // route rejects requests without it. Unset = cron route disabled.
    secret: () => readOptional("CRON_SECRET"),
  },
  assistant: {
    // Opt-in: let the LLM refine the tool choice (within the deterministic
    // source-policy family) on low-confidence turns. DISABLED by default — the
    // deterministic planner stays primary. Costs one extra model call when it
    // actually fires (only on low-confidence turns).
    llmToolChoice: () =>
      (readOptional("ASSISTANT_LLM_TOOL_CHOICE") ?? "false").toLowerCase() === "true",
    // Route turns through the full agentic tool-calling loop: the model chooses +
    // chains tools and reasons over the raw data itself (like a normal chat model
    // with the files attached), instead of the keyword-routed deterministic
    // pipeline. ENABLED by default — this is the primary path. Set
    // ASSISTANT_AGENT_MODE=false to fall back to the deterministic pipeline.
    agentMode: () =>
      (readOptional("ASSISTANT_AGENT_MODE") ?? "true").toLowerCase() === "true",
  },
  // Where the app's own data (document chunks, dossier, feedback, sync cursors)
  // is persisted. "local" = JSON/SQLite files on a writable disk (VPS, the
  // historical default). "cloud" = Turso (vectors/chunks) + Firestore (the small
  // JSON stores) — required on serverless hosts like Vercel, which have no
  // persistent filesystem. Project/account domain data is always in Firestore.
  storeBackend: (): "local" | "cloud" => {
    const raw = (readOptional("STORE_BACKEND") ?? "local").toLowerCase();
    return raw === "cloud" ? "cloud" : "local";
  },
  documents: {
    // Local JSON file holding uploaded-document metadata + chunks. Uploaded
    // documents are NOT stored in Firestore (Firestore is only project data).
    // Used only by the "local" store backend.
    storePath: () =>
      readOptional("DOCUMENT_STORE_PATH") ??
      "/var/lib/norne-chatbot/knowledge-documents.json",
  },
  turso: {
    // Managed libSQL (SQLite-compatible) database holding chunk embeddings for
    // semantic search on the "cloud" backend. Serverless-friendly (HTTP client),
    // unlike better-sqlite3 which needs a native build + local file. Create a DB
    // at turso.tech and read the URL/token from the dashboard or `turso db`.
    url: () => readOptional("TURSO_DATABASE_URL"),
    authToken: () => readOptional("TURSO_AUTH_TOKEN"),
  },
  rag: {
    // Which vector backend to use. "sqlite" = local better-sqlite3 + sqlite-vec
    // file (VPS). "turso" = managed libSQL over HTTP (serverless/Vercel). Defaults
    // to sqlite so existing VPS deployments are unchanged. The turso module is
    // lazy-loaded, so better-sqlite3 is never imported when turso is selected.
    vectorBackend: (): "sqlite" | "turso" => {
      const raw = (readOptional("VECTOR_BACKEND") ?? "sqlite").toLowerCase();
      return raw === "turso" ? "turso" : "sqlite";
    },
    // Local SQLite (sqlite-vec) file holding chunk embeddings for semantic
    // search. Scales far past the in-memory JSON keyword index — used for large
    // corpora (e.g. a synced SharePoint library). Sibling of the JSON store by
    // default. NOT in Firestore. Used only by the "sqlite" vector backend.
    vectorStorePath: () =>
      readOptional("VECTOR_STORE_PATH") ??
      "/var/lib/norne-chatbot/vectors.db",
    // Which embeddings backend to use. "voyage" (Anthropic's recommended
    // provider; hosted, free tier), "ollama" (free + local), "openai" (cheap
    // hosted), or "none" (disable semantic search; keyword index only).
    embeddingsProvider: (): "voyage" | "ollama" | "openai" | "none" => {
      const raw = (readOptional("EMBEDDINGS_PROVIDER") ?? "ollama").toLowerCase();
      return raw === "voyage" || raw === "openai" || raw === "none"
        ? raw
        : "ollama";
    },
    // Embedding model. Defaults per provider: voyage-3.5 (Voyage) /
    // nomic-embed-text (Ollama) / text-embedding-3-small (OpenAI).
    embeddingsModel: (): string => {
      const explicit = readOptional("EMBEDDINGS_MODEL");
      if (explicit) return explicit;
      switch (env.rag.embeddingsProvider()) {
        case "voyage":
          return "voyage-3.5";
        case "openai":
          return "text-embedding-3-small";
        default:
          return "nomic-embed-text";
      }
    },
  },
  feedback: {
    // Local JSON file holding answer feedback (thumbs up/down + corrections).
    // Never stores secrets, full chat history, or uploaded document contents.
    storePath: () =>
      readOptional("DOCUMENT_FEEDBACK_PATH") ??
      "/var/lib/norne-chatbot/feedback.json",
  },
  dossier: {
    // Local JSON file holding the generated case "dossier" — a structured
    // overview of the whole case, synthesised across all indexed documents and
    // injected on case/overview questions so the bot has the big picture. Built
    // on demand (scripts/generate-dossier.mjs), NOT in the request path.
    storePath: () =>
      readOptional("DOSSIER_PATH") ?? "/var/lib/norne-chatbot/case-dossier.json",
    // Optional model override for the one-off dossier synthesis. Unset = a
    // top-tier default for the active provider (Opus for Anthropic), since the
    // dossier is high-value and runs outside the request path. The interactive
    // chat model (ANTHROPIC_MODEL) is unaffected.
    model: () => readOptional("DOSSIER_MODEL"),
  },
  sharepoint: {
    // Optional integration: sync a SharePoint document library into the
    // knowledge base via Microsoft Graph (app-only / client credentials).
    // DISABLED by default; the app never requires these at startup. Read-only.
    enabledFlag: () =>
      (readOptional("SHAREPOINT_ENABLED") ?? "false").toLowerCase() === "true",
    // Entra ID (Azure AD) tenant + app registration. The app registration needs
    // application permission Sites.Read.All (+ Files.Read.All), admin-consented.
    tenantId: () => readOptional("SHAREPOINT_TENANT_ID"),
    clientId: () => readOptional("SHAREPOINT_CLIENT_ID"),
    clientSecret: () => readOptional("SHAREPOINT_CLIENT_SECRET"),
    // The site to sync, as "{hostname}:/sites/{path}" (e.g.
    // "flyd.sharepoint.com:/sites/Dokumenter"). Resolved to a site id at runtime.
    site: () => readOptional("SHAREPOINT_SITE"),
    // Optional: restrict to specific document libraries (drive names), comma-
    // separated. Empty = sync every document library on the site.
    driveNames: (): string[] =>
      (readOptional("SHAREPOINT_DRIVES") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    // Optional: restrict to a single folder (and its descendants) within the
    // library, as a drive-root-relative path, e.g. "General/Kunde/Nornebygg".
    // Empty = sync the whole library. Use this to avoid indexing unrelated
    // folders (e.g. other clients' documents) into the shared knowledge base.
    folder: () => readOptional("SHAREPOINT_FOLDER"),
    // Max file size to download/index (MB). Larger files are skipped. Default 25.
    maxFileMb: () => Number.parseInt(readOptional("SHAREPOINT_MAX_FILE_MB") ?? "25", 10),
    // Where per-drive delta cursors are persisted (local JSON), so syncs are
    // incremental. Optional; defaults next to the other state files.
    statePath: () =>
      readOptional("SHAREPOINT_STATE_PATH") ??
      "/var/lib/norne-chatbot/sharepoint-sync.json",
  },
  endre: {
    // Optional external integration with the Endre public REST API. DISABLED by
    // default; the app never requires these at startup. Reads only — never
    // logged. See lib/endre/client.ts.
    enabledFlag: () =>
      (readOptional("ENDRE_API_ENABLED") ?? "false").toLowerCase() === "true",
    baseUrl: () =>
      readOptional("ENDRE_API_BASE_URL") ?? "https://public-api.endre.app",
    username: () => readOptional("ENDRE_API_USERNAME"),
    password: () => readOptional("ENDRE_API_PASSWORD"),
    clientId: () => readOptional("ENDRE_API_CLIENT_ID"),
    clientSecret: () => readOptional("ENDRE_API_CLIENT_SECRET"),
  },
  firebase: {
    projectId: () => requireVar("FIREBASE_PROJECT_ID"),

    // Option A — Admin SDK (service account)
    clientEmail: () => readOptional("FIREBASE_CLIENT_EMAIL"),
    privateKey: () => {
      const key = readOptional("FIREBASE_PRIVATE_KEY");
      // Env files often store the key with literal "\n"; restore real newlines.
      return key ? key.replace(/\\n/g, "\n") : undefined;
    },

    // Option B — REST sign-in (email/password + web API key)
    apiKey: () => readOptional("FIREBASE_API_KEY"),
    authEmail: () => readOptional("FIREBASE_AUTH_EMAIL"),
    authPassword: () => readOptional("FIREBASE_AUTH_PASSWORD"),
  },
} as const;

/** True when Endre credentials (username + password) are both present. */
export function endreConfigured(): boolean {
  return Boolean(env.endre.username() && env.endre.password());
}

/**
 * True when the Endre integration may actually be used: the feature flag is on
 * AND the required credentials are present. Defaults to false. The app never
 * fails to start when this is false.
 */
export function endreReady(): boolean {
  return env.endre.enabledFlag() && endreConfigured();
}

/** True when all required SharePoint credentials are present. */
export function sharepointConfigured(): boolean {
  return Boolean(
    env.sharepoint.tenantId() &&
      env.sharepoint.clientId() &&
      env.sharepoint.clientSecret() &&
      env.sharepoint.site(),
  );
}

/** True when the SharePoint sync may run: flag on AND credentials present. */
export function sharepointReady(): boolean {
  return env.sharepoint.enabledFlag() && sharepointConfigured();
}

export type FirestoreMode = "admin" | "rest";

/** Which Firestore backend the current environment can use (admin preferred). */
export function detectFirestoreBackend(): FirestoreMode | "none" {
  if (readOptional("FIREBASE_CLIENT_EMAIL") && readOptional("FIREBASE_PRIVATE_KEY")) {
    return "admin";
  }
  if (
    readOptional("FIREBASE_API_KEY") &&
    readOptional("FIREBASE_AUTH_EMAIL") &&
    readOptional("FIREBASE_AUTH_PASSWORD")
  ) {
    return "rest";
  }
  return "none";
}

export interface EnvValidation {
  mode: FirestoreMode;
  llmProvider: LlmProvider;
  warnings: string[];
}

/**
 * Fail-fast validation of the server environment. Call this on the first server
 * request (and/or startup). Throws a single clear error listing everything that
 * is missing, supporting BOTH Admin SDK mode and REST fallback mode, and BOTH
 * the OpenAI and Ollama LLM providers.
 *
 * Never includes secret values in the thrown message.
 */
export function validateEnv(): EnvValidation {
  const missing: string[] = [];
  const errors: string[] = [];

  if (!readOptional("FIREBASE_PROJECT_ID")) missing.push("FIREBASE_PROJECT_ID");

  // --- LLM provider --------------------------------------------------------
  const rawProvider = (readOptional("LLM_PROVIDER") ?? "anthropic").toLowerCase();
  const providerSupported = (SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(
    rawProvider,
  );
  if (!providerSupported) {
    errors.push(
      `Unsupported LLM_PROVIDER "${rawProvider}". Supported: ${SUPPORTED_LLM_PROVIDERS.join(", ")}.`,
    );
  } else if (rawProvider === "anthropic") {
    if (!readOptional("ANTHROPIC_API_KEY")) {
      missing.push("ANTHROPIC_API_KEY (required when LLM_PROVIDER=anthropic)");
    }
  } else if (rawProvider === "openai") {
    if (!readOptional("OPENAI_API_KEY")) {
      missing.push("OPENAI_API_KEY (required when LLM_PROVIDER=openai)");
    }
  } else if (rawProvider === "ollama") {
    if (!readOptional("OLLAMA_MODEL")) {
      missing.push("OLLAMA_MODEL (required when LLM_PROVIDER=ollama)");
    }
  }

  // --- Firestore backend ---------------------------------------------------
  const hasAdmin = Boolean(
    readOptional("FIREBASE_CLIENT_EMAIL") && readOptional("FIREBASE_PRIVATE_KEY"),
  );
  const hasRest = Boolean(
    readOptional("FIREBASE_API_KEY") &&
      readOptional("FIREBASE_AUTH_EMAIL") &&
      readOptional("FIREBASE_AUTH_PASSWORD"),
  );
  if (!hasAdmin && !hasRest) {
    errors.push(
      "No Firestore backend configured. Provide EITHER Admin SDK mode " +
        "(FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY) OR REST fallback mode " +
        "(FIREBASE_API_KEY + FIREBASE_AUTH_EMAIL + FIREBASE_AUTH_PASSWORD).",
    );
  }

  // --- Site password lock (production only) --------------------------------
  // The whole-site lock has no built-in production default; without these vars it
  // fails closed (lib/site-auth.ts). Surface the misconfiguration loudly at the
  // request edge too. In dev/test, placeholders are used, so don't require them.
  if (process.env.NODE_ENV === "production") {
    if (!readOptional("SITE_AUTH_PASSWORD")) {
      missing.push("SITE_AUTH_PASSWORD (required in production)");
    }
    if (!readOptional("SITE_AUTH_SECRET")) {
      missing.push("SITE_AUTH_SECRET (required in production)");
    }
  }

  if (missing.length > 0) {
    errors.unshift(`Missing required variable(s): ${missing.join(", ")}.`);
  }
  if (errors.length > 0) {
    throw new Error(`Invalid server configuration:\n- ${errors.join("\n- ")}`);
  }

  const mode: FirestoreMode = hasAdmin ? "admin" : "rest";
  const llmProvider = rawProvider as LlmProvider;
  const warnings: string[] = [];
  if (hasAdmin && hasRest) {
    warnings.push("Both Admin SDK and REST credentials are set; using Admin SDK.");
  }
  if (mode === "rest") {
    warnings.push(
      "Using REST (email/password) Firestore mode — temporary fallback, " +
        "prefer Admin SDK.",
    );
  }
  if (llmProvider === "ollama") {
    warnings.push(
      `Using local Ollama LLM provider (${env.ollama.baseUrl()}). Ensure the ` +
        "server is running and the model is pulled.",
    );
  }
  // The embeddings provider defaults to "ollama", but a cloud (serverless) deploy
  // can't reach a localhost Ollama — that silently breaks semantic search. Warn on
  // the likely-misconfigured combination so it doesn't fail invisibly.
  if (
    env.storeBackend() === "cloud" &&
    env.rag.embeddingsProvider() === "ollama" &&
    /localhost|127\.0\.0\.1/.test(env.ollama.baseUrl())
  ) {
    warnings.push(
      "EMBEDDINGS_PROVIDER is 'ollama' (the default) with a localhost " +
        "OLLAMA_BASE_URL while STORE_BACKEND=cloud — a serverless deploy cannot " +
        "reach a local Ollama, so semantic search will silently fail. Set " +
        "EMBEDDINGS_PROVIDER=voyage (recommended) or point OLLAMA_BASE_URL at a " +
        "reachable host.",
    );
  }
  return { mode, llmProvider, warnings };
}
