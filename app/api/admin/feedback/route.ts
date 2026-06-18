/**
 * GET /api/admin/feedback  (token-protected)
 *
 *   GET /api/admin/feedback            -> JSON list of feedback records
 *   GET /api/admin/feedback?export=1   -> same JSON as a downloadable file
 *
 * Auth: Authorization: Bearer <ADMIN_UPLOAD_TOKEN>. Server-side only; the token
 * is never exposed to the browser. Records are already sanitised at write time
 * (no secrets / no full history / no document contents).
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import {
  isFilesystemPermissionError,
  listFeedback,
} from "@/lib/feedback/store";
import { logAdminError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function guard(request: Request) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "Adminfunksjoner er ikke konfigurert på serveren." },
      { status: 503 },
    );
  }
  if (!isAdminAuthorized(request)) {
    return NextResponse.json({ error: "Ikke autorisert." }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  const requestId = newRequestId();
  try {
    const feedback = await listFeedback();
    const wantsExport =
      new URL(request.url).searchParams.get("export") !== null;
    const headers: HeadersInit = wantsExport
      ? {
          "Content-Disposition": 'attachment; filename="norne-feedback.json"',
        }
      : {};
    return NextResponse.json(
      { feedback, count: feedback.length },
      { status: 200, headers },
    );
  } catch (error) {
    logAdminError(requestId, "feedback-list", error);
    if (isFilesystemPermissionError(error)) {
      return NextResponse.json(
        {
          error:
            "Kan ikke lese tilbakemeldingslageret. Sjekk at DOCUMENT_FEEDBACK_PATH er lesbar.",
          requestId,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: "Kunne ikke hente tilbakemeldinger.", requestId },
      { status: 500 },
    );
  }
}
