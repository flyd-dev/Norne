/**
 * POST /api/feedback
 *
 * Body: {
 *   rating: "good" | "bad",
 *   question: string,
 *   answer: string,
 *   sources?: string[],
 *   route?: string | null,
 *   correction?: string | null   // only meaningful for "bad"
 * }
 *
 * Stores a sanitised feedback record on the server (no secrets, no full chat
 * history, no uploaded document contents — only short source labels). Open to
 * end users (no admin token); the admin GET endpoint is token-protected.
 */

import { NextResponse } from "next/server";
import {
  appendFeedback,
  isFilesystemPermissionError,
  type FeedbackRating,
} from "@/lib/feedback/store";
import { errorTypeOf, logChatError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 4000;

function clientError(message: string, status: number, requestId: string) {
  return NextResponse.json({ error: message, requestId }, { status });
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export async function POST(request: Request) {
  const requestId = newRequestId();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return clientError("Ugyldig JSON i forespørselen.", 400, requestId);
  }

  const b = body as Record<string, unknown>;
  const rating = b?.rating;
  if (rating !== "good" && rating !== "bad") {
    return clientError("Feltet 'rating' må være 'good' eller 'bad'.", 400, requestId);
  }
  const question = typeof b?.question === "string" ? b.question : "";
  const answer = typeof b?.answer === "string" ? b.answer : "";
  if (question.trim().length === 0 || answer.trim().length === 0) {
    return clientError(
      "Feltene 'question' og 'answer' må være ikke-tomme.",
      400,
      requestId,
    );
  }
  if (question.length > MAX_TEXT || answer.length > MAX_TEXT) {
    return clientError("Tilbakemeldingen er for lang.", 400, requestId);
  }

  try {
    const record = await appendFeedback({
      rating: rating as FeedbackRating,
      question,
      answer,
      sources: asStringArray(b?.sources),
      route: typeof b?.route === "string" ? b.route : null,
      correction: typeof b?.correction === "string" ? b.correction : null,
    });
    return NextResponse.json(
      { ok: true, timestamp: record.timestamp },
      { status: 201 },
    );
  } catch (error) {
    logChatError(requestId, errorTypeOf(error));
    if (isFilesystemPermissionError(error)) {
      return clientError(
        "Kan ikke lagre tilbakemelding på serveren akkurat nå.",
        500,
        requestId,
      );
    }
    return clientError("Kunne ikke lagre tilbakemeldingen.", 500, requestId);
  }
}
