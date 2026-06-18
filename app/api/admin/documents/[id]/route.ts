/**
 * DELETE /api/admin/documents/{id}
 *
 * Removes a knowledge document and all its chunks. Token-protected.
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import { deleteDocument } from "@/lib/documents/store";
import { isPermissionDenied } from "@/lib/firestore/types";
import { logAdminError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "Dokumentopplasting er ikke konfigurert på serveren." },
      { status: 503 },
    );
  }
  if (!isAdminAuthorized(request)) {
    return NextResponse.json({ error: "Ikke autorisert." }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "Mangler dokument-id." }, { status: 400 });
  }

  const requestId = newRequestId();
  try {
    await deleteDocument(id);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logAdminError(requestId, "delete", error);
    if (isPermissionDenied(error)) {
      return NextResponse.json(
        {
          error:
            "Firestore-tilgang er avvist for «knowledge_documents». Sjekk reglene eller bruk Admin SDK.",
          requestId,
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "Kunne ikke slette dokumentet.", requestId },
      { status: 500 },
    );
  }
}
