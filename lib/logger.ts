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

/** Derive a safe error type name from an unknown thrown value. */
export function errorTypeOf(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return "UnknownError";
}
