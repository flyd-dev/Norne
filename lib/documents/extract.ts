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
  type StructuredColumns,
  type StructuredRow,
  type StructuredTable,
  type SupportedFileType,
} from "@/lib/documents/types";
import { normalizeRole } from "@/lib/chat/roles";

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

/** Sheet names that signal a staffing/capacity plan worth parsing structurally. */
const STAFFING_SHEET_RE =
  /(kapasitetsanalyse|rotasjonsplan|bemanning|ressurs|timer|kapasitet)/i;

/** Header keywords → logical column, checked in order (first match wins). */
const COLUMN_MATCHERS: { field: keyof StructuredColumns; re: RegExp }[] = [
  { field: "availableHours", re: /(tilgjengelig|ledig|disponibel|kapasitet|available|free)/i },
  { field: "assignedHours", re: /(tildelt|planlagt|brukt|allokert|booket|assigned|allocated|planned)/i },
  { field: "month", re: /(m(å|a)ned|måned|dato|uke|periode|month|date|week|period)/i },
  { field: "role", re: /(fag|rolle|stilling|disiplin|trade|role|discipline)/i },
  { field: "person", re: /(navn|person|ressurs|ansatt|montør|name|employee|resource)/i },
];

/** Parse a Norwegian/English number cell ("1 200", "1.200", "1200") → number. */
function parseNumberCell(value: string): number | null {
  const cleaned = value.replace(/[^\d,.\s-]/g, "").trim();
  if (cleaned === "") return null;
  // Strip thousands separators (space / dot), keep a trailing decimal comma part.
  const digits = cleaned.replace(/[\s.](?=\d{3}\b)/g, "").replace(",", ".");
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

/** Map a header row to logical columns by keyword. Returns indexes + names. */
function mapColumns(headers: string[]): {
  columns: StructuredColumns;
  index: Partial<Record<keyof StructuredColumns, number>>;
} {
  const columns: StructuredColumns = {};
  const index: Partial<Record<keyof StructuredColumns, number>> = {};
  headers.forEach((raw, i) => {
    const header = raw.trim();
    if (!header) return;
    for (const { field, re } of COLUMN_MATCHERS) {
      if (columns[field] !== undefined) continue; // first column of a kind wins
      if (re.test(header)) {
        columns[field] = header;
        index[field] = i;
        break;
      }
    }
  });
  return { columns, index };
}

/** Build a structured table from one sheet's rows, or null if not staffing-like. */
function structuredFromSheet(
  sheetName: string,
  rows: unknown[][],
): StructuredTable | null {
  if (rows.length < 2) return null;
  const headers = rows[0].map((h) => String(h ?? "").trim());
  const { columns, index } = mapColumns(headers);

  // A sheet qualifies if its name looks like staffing OR it has a capacity-ish
  // column together with a role/month column — otherwise we leave it as text.
  const nameLooksStaffing = STAFFING_SHEET_RE.test(sheetName);
  const hasCapacityCol =
    columns.availableHours !== undefined || columns.assignedHours !== undefined;
  const hasContextCol =
    columns.role !== undefined ||
    columns.month !== undefined ||
    columns.person !== undefined;
  if (!nameLooksStaffing && !(hasCapacityCol && hasContextCol)) return null;
  // Need at least one usable column to produce anything.
  if (Object.keys(index).length === 0) return null;

  const at = (row: unknown[], field: keyof StructuredColumns): string => {
    const i = index[field];
    return i === undefined ? "" : String(row[i] ?? "").trim();
  };

  const structuredRows: StructuredRow[] = [];
  for (const row of rows.slice(1)) {
    if (!row.some((v) => String(v ?? "").trim() !== "")) continue;
    const rawRole = at(row, "role") || null;
    const monthCell = at(row, "month") || null;
    const personCell = at(row, "person") || null;
    const available = parseNumberCell(at(row, "availableHours"));
    const assigned = parseNumberCell(at(row, "assignedHours"));
    const role = rawRole ? normalizeRole(rawRole) : null;
    // Skip rows that carry nothing useful.
    if (
      !rawRole &&
      !monthCell &&
      !personCell &&
      available === null &&
      assigned === null
    ) {
      continue;
    }
    structuredRows.push({
      month: monthCell,
      role,
      rawRole,
      availableHours: available,
      assignedHours: assigned,
      person: personCell,
    });
  }

  if (structuredRows.length === 0) return null;
  return { sheetName, columns, rows: structuredRows };
}

/**
 * Split one line of extracted text into table cells, or null when it isn't a
 * row. Recognises tab-, pipe- and run-of-spaces-delimited columns (how tables
 * survive PDF/DOCX text extraction). Leading/trailing empty cells from a pipe
 * border ("| a | b |") are dropped.
 */
function splitTextRow(line: string): string[] | null {
  let cells: string[];
  if (line.includes("\t")) cells = line.split("\t");
  else if (line.includes("|")) cells = line.split("|");
  else if (/\S\s{2,}\S/.test(line)) cells = line.split(/\s{2,}/);
  else return null;
  cells = cells.map((c) => c.trim());
  while (cells.length > 0 && cells[0] === "") cells.shift();
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells.length >= 2 ? cells : null;
}

/**
 * Detect staffing/capacity TABLES embedded in extracted PDF/DOCX text. Groups
 * consecutive delimiter-rows into grids and runs each through structuredFromSheet
 * — which only accepts staffing-like grids (capacity + role/month columns), so
 * ordinary prose never produces a spurious table.
 */
export function tablesFromText(text: string): StructuredTable[] {
  const lines = text.split("\n");
  const tables: StructuredTable[] = [];
  let block: string[][] = [];
  const flush = () => {
    if (block.length >= 2) {
      const table = structuredFromSheet("dokument", block);
      if (table) tables.push(table);
    }
    block = [];
  };
  for (const line of lines) {
    const cells = splitTextRow(line);
    if (cells) block.push(cells);
    else flush();
  }
  flush();
  return tables;
}

interface XlsxExtraction {
  segments: ExtractedSegment[];
  structured: StructuredTable[];
}

function extractXlsx(buffer: Buffer): XlsxExtraction {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const segments: ExtractedSegment[] = [];
  const structured: StructuredTable[] = [];
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
    const table = structuredFromSheet(sheetName, rows);
    if (table) structured.push(table);
  }
  return { segments, structured };
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
  let structured: StructuredTable[] | undefined;

  switch (fileType) {
    case "txt":
      segments = [{ text: buffer.toString("utf8") }];
      break;
    case "csv":
      segments = [{ text: rowsToText(parseCsv(buffer.toString("utf8"))) }];
      break;
    case "xlsx": {
      const x = extractXlsx(buffer);
      segments = x.segments;
      structured = x.structured.length > 0 ? x.structured : undefined;
      break;
    }
    case "pdf": {
      const text = await extractPdf(buffer);
      segments = [{ text }];
      const t = tablesFromText(text);
      if (t.length > 0) structured = t;
      break;
    }
    case "docx": {
      const text = await extractDocx(buffer);
      segments = [{ text }];
      const t = tablesFromText(text);
      if (t.length > 0) structured = t;
      break;
    }
  }

  const total = segments.reduce((n, s) => n + s.text.trim().length, 0);
  if (total === 0) {
    throw new ExtractionError("Fant ingen tekst å hente ut fra filen.");
  }

  return { fileType, segments, ...(structured ? { structured } : {}) };
}
