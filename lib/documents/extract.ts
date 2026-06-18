/**
 * Text extraction from uploaded documents.
 *
 * Supported: PDF, DOCX, TXT, CSV, XLSX. XLSX yields one segment per sheet,
 * preserving sheet name, headers and row values. Heavy parsers (pdf/docx) are
 * imported dynamically so they only load when actually needed.
 *
 * Pure parsing logic (no Firestore / secrets), so it is straightforward to test.
 */

import * as XLSX from "xlsx";
import {
  ExtractionError,
  SUPPORTED_FILE_TYPES,
  UnsupportedFileTypeError,
  type ExtractedContent,
  type ExtractedSegment,
  type SupportedFileType,
} from "@/lib/documents/types";

/** Determine the supported file type from a filename, or throw. */
export function fileTypeFromName(fileName: string): SupportedFileType {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if ((SUPPORTED_FILE_TYPES as readonly string[]).includes(ext)) {
    return ext as SupportedFileType;
  }
  throw new UnsupportedFileTypeError(
    `Filtypen «.${ext}» støttes ikke. Tillatte typer: ${SUPPORTED_FILE_TYPES.join(", ")}.`,
  );
}

/** Minimal CSV line parser handling quoted fields and escaped quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Turn tabular rows into readable "header: value | header: value" lines. */
function rowsToText(rows: unknown[][]): string {
  if (rows.length === 0) return "";
  const headers = rows[0].map((h) => String(h).trim());
  const hasHeaders = headers.some((h) => h.length > 0);
  const body = hasHeaders ? rows.slice(1) : rows;

  const lines = body.map((row) => {
    if (hasHeaders) {
      return row
        .map((value, i) => {
          const key = headers[i] || `kolonne ${i + 1}`;
          return `${key}: ${String(value).trim()}`;
        })
        .filter((pair) => !pair.endsWith(": "))
        .join(" | ");
    }
    return row.map((v) => String(v).trim()).join(" | ");
  });

  const header = hasHeaders ? `Kolonner: ${headers.filter(Boolean).join(", ")}\n` : "";
  return header + lines.filter((l) => l.trim() !== "").join("\n");
}

function extractXlsx(buffer: Buffer): ExtractedSegment[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const segments: ExtractedSegment[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      blankrows: false,
      defval: "",
      raw: false,
    }) as unknown[][];
    const text = rowsToText(rows);
    if (text.trim().length > 0) {
      segments.push({ sheetName, text: `Ark: ${sheetName}\n${text}` });
    }
  }
  return segments;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    // Import the inner lib to avoid pdf-parse's debug index reading a test file.
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = (mod as { default: (b: Buffer) => Promise<{ text: string }> })
      .default;
    const data = await pdfParse(buffer);
    return data.text;
  } catch {
    throw new ExtractionError("Kunne ikke lese PDF-filen.");
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch {
    throw new ExtractionError("Kunne ikke lese DOCX-filen.");
  }
}

/**
 * Extract text from a document buffer based on its filename.
 * Throws UnsupportedFileTypeError or ExtractionError on failure.
 */
export async function extractText(
  buffer: Buffer,
  fileName: string,
): Promise<ExtractedContent> {
  const fileType = fileTypeFromName(fileName);
  let segments: ExtractedSegment[];

  switch (fileType) {
    case "txt":
      segments = [{ text: buffer.toString("utf8") }];
      break;
    case "csv":
      segments = [{ text: rowsToText(parseCsv(buffer.toString("utf8"))) }];
      break;
    case "xlsx":
      segments = extractXlsx(buffer);
      break;
    case "pdf":
      segments = [{ text: await extractPdf(buffer) }];
      break;
    case "docx":
      segments = [{ text: await extractDocx(buffer) }];
      break;
  }

  const total = segments.reduce((n, s) => n + s.text.trim().length, 0);
  if (total === 0) {
    throw new ExtractionError("Fant ingen tekst å hente ut fra filen.");
  }

  return { fileType, segments };
}
