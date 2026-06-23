/**
 * Admin dossier routes (token-protected).
 *
 *   POST /api/admin/dossier  -> (re)generate the case dossier from all documents
 *   GET  /api/admin/dossier  -> return the current dossier (text + metadata)
 *
 * Generation makes one LLM call over excerpts of every indexed document, so it
 * can take a while — run it after a sync, not on every request.
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import { generateDossier } from "@/lib/dossier/generate";
import { readDossier } from "@/lib/dossier/store";
import { errorTypeOf, logAdminError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function guard(request: Request) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "Admin-ruter er ikke konfigurert på serveren." },
      { status: 503 },
    );
  }
  if (!isAdminAuthorized(request)) {
    return NextResponse.json({ error: "Ikke autorisert." }, { status: 401 });
  }
  return null;
}

export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  const requestId = newRequestId();
  try {
    const dossier = await generateDossier();
    if (!dossier) {
      return NextResponse.json(
        { error: "Ingen dokumenter å lage dossier av." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        documentCount: dossier.documentCount,
        length: dossier.text.length,
        generatedAt: dossier.generatedAt,
      },
      { status: 200 },
    );
  } catch (error) {
    logAdminError(requestId, "dossier_generate", error);
    return NextResponse.json(
      {
        error:
          "Kunne ikke lage dossier. Sjekk at LLM-provideren (Anthropic/OpenAI) er tilgjengelig.",
        errorType: errorTypeOf(error),
        requestId,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  const dossier = await readDossier();
  if (!dossier) {
    return NextResponse.json({ error: "Ingen dossier generert ennå." }, { status: 404 });
  }
  return NextResponse.json(dossier, { status: 200 });
}
