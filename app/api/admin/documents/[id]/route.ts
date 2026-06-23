/**
 * DELETE /api/admin/documents/{id}
 *
 * Removes a knowledge document and all its chunks. Token-protected.
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import { deleteDocument, isFilesystemPermissionError } from "@/lib/documents/store";
import { removeDocumentFromIndex } from "@/lib/rag/indexDocument";
import { errorTypeOf, logAdminError, newRequestId } from "@/lib/logger";

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
    // Best-effort: also drop the document's vectors from the semantic index.
    try {
      await removeDocumentFromIndex(id);
    } catch (error) {
      console.error(
        JSON.stringify({
          evt: "index_delete_failed",
          errorType: errorTypeOf(error),
        }),
      );
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logAdminError(requestId, "delete", error);
    if (isFilesystemPermissionError(error)) {
      return NextResponse.json(
        {
          error:
            "Kan ikke skrive til dokumentlageret på serveren. Sjekk at DOCUMENT_STORE_PATH er skrivbar.",
          requestId,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: "Kunne ikke slette dokumentet.", requestId },
      { status: 500 },
    );
  }
}
