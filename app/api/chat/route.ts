/**
 * POST /api/chat
 *
 * Body:    { "message": string }
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
import { runChat } from "@/lib/chat/orchestrator";
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

function clientError(message: string, status: number, requestId: string) {
  return NextResponse.json({ error: message, requestId }, { status });
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

  logChatRequest(requestId, message.length);

  // --- Fail fast on misconfiguration (no secret values in the response) ----
  try {
    validateEnv();
  } catch (error) {
    logChatError(requestId, errorTypeOf(error));
    return clientError("Tjenesten er ikke riktig konfigurert.", 500, requestId);
  }

  // --- Run orchestration ----------------------------------------------------
  try {
    const result = await runChat(message.trim(), requestId);
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
