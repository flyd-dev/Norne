/**
 * POST /api/admin/documents/reindex
 *
 * Rebuilds the semantic (sqlite-vec) index from every chunk already in the JSON
 * store. Run once after enabling embeddings to backfill documents uploaded
 * before semantic search existed. Token-protected; safe to re-run (idempotent
 * per document). No-op when EMBEDDINGS_PROVIDER=none.
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import { reindexAllFromJsonStore } from "@/lib/rag/indexDocument";
import { errorTypeOf, logAdminError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Re-embedding a large corpus can take a while; allow up to 5 minutes.
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "Dokumentopplasting er ikke konfigurert på serveren." },
      { status: 503 },
    );
  }
  if (!isAdminAuthorized(request)) {
    return NextResponse.json({ error: "Ikke autorisert." }, { status: 401 });
  }

  const requestId = newRequestId();
  try {
    const result = await reindexAllFromJsonStore();
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    logAdminError(requestId, "reindex", error);
    return NextResponse.json(
      {
        error:
          "Kunne ikke reindeksere. Sjekk at embeddings-backenden (Ollama/OpenAI) er tilgjengelig.",
        errorType: errorTypeOf(error),
        requestId,
      },
      { status: 500 },
    );
  }
}
