/**
 * Admin document routes (token-protected).
 *
 *   GET  /api/admin/documents  -> list knowledge documents
 *   POST /api/admin/documents  -> upload a file (multipart form-data, field "file")
 *
 * Auth: Authorization: Bearer <ADMIN_UPLOAD_TOKEN>. Server-side only; the token
 * is never exposed to the browser. Errors are generic; file contents are never
 * logged.
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import { extractText, fileTypeFromName } from "@/lib/documents/extract";
import { buildChunks } from "@/lib/documents/chunk";
import { listDocuments, saveDocument } from "@/lib/documents/store";
import {
  ExtractionError,
  UnsupportedFileTypeError,
} from "@/lib/documents/types";
import { isPermissionDenied } from "@/lib/firestore/types";
import { logAdminError, newRequestId } from "@/lib/logger";

const PERMISSION_DENIED_MESSAGE =
  "Firestore-tilgang er avvist for samlingen «knowledge_documents». " +
  "Sjekk Firestore-reglene, eller bruk en tjenestekonto (Admin SDK).";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Max upload size: 10 MB. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function guard(request: Request) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "Dokumentopplasting er ikke konfigurert på serveren." },
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
    // An empty / non-existent knowledge_documents collection yields [] (not 500).
    const documents = await listDocuments();
    return NextResponse.json({ documents }, { status: 200 });
  } catch (error) {
    logAdminError(requestId, "list", error);
    if (isPermissionDenied(error)) {
      return NextResponse.json(
        { error: PERMISSION_DENIED_MESSAGE, requestId },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "Kunne ikke hente dokumentlisten.", requestId },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  const requestId = newRequestId();

  // --- Parse the multipart form ---------------------------------------------
  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("file");
    if (value instanceof File) file = value;
  } catch {
    return NextResponse.json(
      { error: "Ugyldig opplasting (forventet form-data med felt 'file')." },
      { status: 400 },
    );
  }

  if (!file) {
    return NextResponse.json(
      { error: "Ingen fil ble lastet opp (felt 'file' mangler)." },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "Filen er tom." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Filen er for stor (maks ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB).` },
      { status: 413 },
    );
  }

  // Reject unsupported types up front (clear 415).
  try {
    fileTypeFromName(file.name);
  } catch {
    return NextResponse.json(
      { error: "Filtypen støttes ikke. Tillatt: PDF, DOCX, TXT, CSV, XLSX." },
      { status: 415 },
    );
  }

  // --- Extract, chunk, store ------------------------------------------------
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const content = await extractText(buffer, file.name);

    const documentId = crypto.randomUUID();
    const uploadedAt = new Date().toISOString();
    const chunks = buildChunks(content, {
      documentId,
      documentName: file.name,
      uploadedAt,
    });

    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "Fant ingen tekst å indeksere i filen." },
        { status: 400 },
      );
    }

    await saveDocument(
      { id: documentId, name: file.name, fileType: content.fileType, uploadedAt },
      chunks,
    );

    return NextResponse.json(
      {
        document: {
          id: documentId,
          name: file.name,
          fileType: content.fileType,
          uploadedAt,
          chunkCount: chunks.length,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (
      error instanceof UnsupportedFileTypeError ||
      error instanceof ExtractionError
    ) {
      // Safe to surface these messages (no secrets / no file contents).
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logAdminError(requestId, "upload", error);
    if (isPermissionDenied(error)) {
      return NextResponse.json(
        { error: PERMISSION_DENIED_MESSAGE, requestId },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "Kunne ikke behandle filen.", requestId },
      { status: 500 },
    );
  }
}
