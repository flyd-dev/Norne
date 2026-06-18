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
    /** Selected provider; defaults to "openai", unknown values fall back to it. */
    provider: (): LlmProvider => {
      const raw = (readOptional("LLM_PROVIDER") ?? "openai").toLowerCase();
      return (SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(raw)
        ? (raw as LlmProvider)
        : "openai";
    },
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
  admin: {
    // Token gating the document-upload admin routes. Optional: if unset, the
    // admin routes are disabled (not the chatbot). Never sent to the browser.
    uploadToken: () => readOptional("ADMIN_UPLOAD_TOKEN"),
  },
  assistant: {
    // Opt-in: let the LLM refine the tool choice (within the deterministic
    // source-policy family) on low-confidence turns. DISABLED by default — the
    // deterministic planner stays primary. Costs one extra model call when it
    // actually fires (only on low-confidence turns).
    llmToolChoice: () =>
      (readOptional("ASSISTANT_LLM_TOOL_CHOICE") ?? "false").toLowerCase() === "true",
  },
  documents: {
    // Local JSON file holding uploaded-document metadata + chunks. Uploaded
    // documents are NOT stored in Firestore (Firestore is only project data).
    storePath: () =>
      readOptional("DOCUMENT_STORE_PATH") ??
      "/var/lib/norne-chatbot/knowledge-documents.json",
  },
  feedback: {
    // Local JSON file holding answer feedback (thumbs up/down + corrections).
    // Never stores secrets, full chat history, or uploaded document contents.
    storePath: () =>
      readOptional("DOCUMENT_FEEDBACK_PATH") ??
      "/var/lib/norne-chatbot/feedback.json",
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
  const rawProvider = (readOptional("LLM_PROVIDER") ?? "openai").toLowerCase();
  const providerSupported = (SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(
    rawProvider,
  );
  if (!providerSupported) {
    errors.push(
      `Unsupported LLM_PROVIDER "${rawProvider}". Supported: ${SUPPORTED_LLM_PROVIDERS.join(", ")}.`,
    );
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
  return { mode, llmProvider, warnings };
}
