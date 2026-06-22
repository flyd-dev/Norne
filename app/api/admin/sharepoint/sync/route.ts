/**
 * POST /api/admin/sharepoint/sync
 *
 * Runs ONE bounded SharePoint sync batch (extract + index up to `maxFiles`
 * files) and returns counts plus `done`. Token-protected. Designed to be called
 * repeatedly (e.g. by scripts/sync-sharepoint.mjs or a cron) until `done: true`
 * — this keeps each call short and makes a large initial load resumable.
 *
 *   body (optional JSON): { "maxFiles": 50 }
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import { sharepointReady } from "@/lib/env";
import { syncBatch } from "@/lib/sharepoint/sync";
import { errorTypeOf, logAdminError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "Admin-ruter er ikke konfigurert på serveren." },
      { status: 503 },
    );
  }
  if (!isAdminAuthorized(request)) {
    return NextResponse.json({ error: "Ikke autorisert." }, { status: 401 });
  }
  if (!sharepointReady()) {
    return NextResponse.json(
      {
        error:
          "SharePoint-sync er ikke konfigurert (sett SHAREPOINT_ENABLED=true og SHAREPOINT_*-variablene).",
      },
      { status: 503 },
    );
  }

  let maxFiles: number | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { maxFiles?: number };
    if (typeof body.maxFiles === "number" && body.maxFiles > 0) {
      maxFiles = Math.min(body.maxFiles, 500);
    }
  } catch {
    // No/invalid body → use the default batch size.
  }

  const requestId = newRequestId();
  try {
    const result = await syncBatch({ maxFiles });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    logAdminError(requestId, "sharepoint_sync", error);
    return NextResponse.json(
      {
        error:
          "SharePoint-sync feilet. Sjekk app-registrering, tilganger (Sites.Read.All) og at SHAREPOINT_SITE er riktig.",
        errorType: errorTypeOf(error),
        requestId,
      },
      { status: 500 },
    );
  }
}
