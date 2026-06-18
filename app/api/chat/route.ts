/**
 * POST /api/chat
 *
 * Body:    { "message": string, "history"?: { role, content }[] }
 *          `history` is optional recent context (used only to resolve follow-up
 *          references like "sjekk den"); the old { message } shape still works.
 * Returns: {
 *   "answer": string,
 *   "sources": string[],
 *   "dataUsed": { "firestoreCollections": string[], "documents": [] },
 *   "warnings": string[]
 * }
 *
 * Server-side only. All Firestore + OpenAI access happens here; no secrets or
 * direct data access ever reach the browser. Errors returned to the client are
 * generic — internal details are logged server-side by type only.
 */

import { NextResponse } from "next/server";
import { validateEnv } from "@/lib/env";
import { runAssistantTurn } from "@/lib/assistant";
import {
  errorTypeOf,
  logChatError,
  logChatRequest,
  newRequestId,
} from "@/lib/logger";

// Node runtime (firebase-admin is not compatible with the edge runtime).
export const runtime = "nodejs";
// This route depends on request input and external data — never statically cache.
export const dynamic = "force-dynamic";

const MAX_MESSAGE_LENGTH = 2000;
/** How many recent messages we accept as follow-up context (last N). */
const MAX_HISTORY_MESSAGES = 6;

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

function clientError(message: string, status: number, requestId: string) {
  return NextResponse.json({ error: message, requestId }, { status });
}

/**
 * Parse optional `history` from the request body. Invalid/oversized history is
 * silently ignored (it is only a retrieval hint) — never a hard error, so the
 * old { message } contract keeps working. Each item is length-capped and only
 * the last MAX_HISTORY_MESSAGES are kept; nothing here is persisted or logged.
 */
function parseHistory(body: unknown): HistoryMessage[] {
  const raw = (body as { history?: unknown })?.history;
  if (!Array.isArray(raw)) return [];
  const items: HistoryMessage[] = [];
  for (const entry of raw) {
    const role = (entry as { role?: unknown })?.role;
    const content = (entry as { content?: unknown })?.content;
    if ((role === "user" || role === "assistant") && typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        items.push({ role, content: trimmed.slice(0, MAX_MESSAGE_LENGTH) });
      }
    }
  }
  return items.slice(-MAX_HISTORY_MESSAGES);
}

export async function POST(request: Request) {
  const requestId = newRequestId();

  // --- Parse + validate input (takes precedence over config errors) --------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return clientError("Ugyldig JSON i forespørselen.", 400, requestId);
  }

  const message = (body as { message?: unknown })?.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    return clientError("Feltet 'message' må være en ikke-tom tekst.", 400, requestId);
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return clientError(
      `Meldingen er for lang (maks ${MAX_MESSAGE_LENGTH} tegn).`,
      400,
      requestId,
    );
  }

  const history = parseHistory(body);

  // Log lengths/counts only — never message or history content.
  logChatRequest(requestId, message.length);

  // --- Fail fast on misconfiguration (no secret values in the response) ----
  try {
    validateEnv();
  } catch (error) {
    logChatError(requestId, errorTypeOf(error));
    return clientError("Tjenesten er ikke riktig konfigurert.", 500, requestId);
  }

  // --- Run the assistant turn (runner is the public entry) ------------------
  try {
    const result = await runAssistantTurn(message.trim(), requestId, history);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    // Log by type only — never the message/stack (may contain sensitive data).
    logChatError(requestId, errorTypeOf(error));
    return clientError(
      "Noe gikk galt under behandlingen av forespørselen.",
      500,
      requestId,
    );
  }
}

export function GET() {
  return NextResponse.json(
    { error: "Bruk POST med { message: string }." },
    { status: 405 },
  );
}
