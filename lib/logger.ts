/**
 * Safe structured logging.
 *
 * Rules:
 *   - NEVER log secrets, tokens, passwords, or full Firestore documents.
 *   - NEVER log raw user message content (may contain sensitive data).
 *   - Log only: request id, intent, collections used, and error TYPE.
 *
 * Kept free of `import "server-only"` so it can be unit-tested directly; it is
 * only ever used from server code in practice.
 */

/** Generate a short request id for tracing a single request through the logs. */
export function newRequestId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // Fallback for environments without crypto.randomUUID.
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function emit(stream: "log" | "error", payload: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...payload });
  if (stream === "error") console.error(line);
  else console.log(line);
}

/** Log that a chat request was received. Logs length only, not content. */
export function logChatRequest(requestId: string, messageLength: number): void {
  emit("log", { evt: "chat_request", requestId, messageLength });
}

/** Log the resolved intent and which collections were used. */
export function logChatResolved(
  requestId: string,
  intent: string[],
  collections: string[],
): void {
  emit("log", { evt: "chat_resolved", requestId, intent, collections });
}

/** Log an error by TYPE only — never the message, stack, or any payload. */
export function logChatError(requestId: string, errorType: string): void {
  emit("error", { evt: "chat_error", requestId, errorType });
}

/**
 * Safe diagnostics for the optional Endre live-data source selection.
 *
 * Logs ONLY the route, boolean readiness/attempt/found flags, the short project
 * query token (a project number, never free-text), the capability source labels,
 * and a coded fallback reason. NEVER logs raw payloads, tokens, credentials, ids,
 * or any user message content.
 */
export function logEndreDiagnostics(
  requestId: string,
  info: {
    route: string;
    endreReady: boolean;
    attemptedEndre: boolean;
    projectQuery: string | null;
    endreFound: boolean;
    endreSources: string[];
    fallbackReason: string | null;
  },
): void {
  emit("log", { evt: "endre_diagnostics", requestId, ...info });
}

/** Derive a safe error type name from an unknown thrown value. */
export function errorTypeOf(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return "UnknownError";
}

/**
 * A short, safe error message for logs. Firestore/HTTP errors are safe to log
 * (no secrets / no document contents); truncated as a precaution.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 300);
  }
  return "unknown";
}

/**
 * Log an admin document-route error with enough detail to debug, but no secrets
 * or document contents. `action` is the route action (list/upload/delete).
 */
export function logAdminError(
  requestId: string,
  action: string,
  error: unknown,
): void {
  emit("error", {
    evt: "admin_documents_error",
    requestId,
    action,
    errorType: errorTypeOf(error),
    message: safeErrorMessage(error),
  });
}
