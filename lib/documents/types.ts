/** Types for the document knowledge base (upload, extraction, chunking, storage). */

export const SUPPORTED_FILE_TYPES = ["pdf", "docx", "txt", "csv", "xlsx"] as const;
export type SupportedFileType = (typeof SUPPORTED_FILE_TYPES)[number];

/** One extracted text segment. For XLSX, one segment per sheet (with sheetName). */
export interface ExtractedSegment {
  sheetName?: string;
  text: string;
}

/**
 * Which spreadsheet column was identified as which logical field. Values are the
 * original header strings (for transparency); any may be absent.
 */
export interface StructuredColumns {
  month?: string;
  role?: string;
  availableHours?: string;
  assignedHours?: string;
  person?: string;
}

/** One parsed row of a staffing/capacity sheet (best-effort, may be sparse). */
export interface StructuredRow {
  /** Month/period label as written in the sheet, if any. */
  month: string | null;
  /** Canonical role/trade (Welder/Steel fixer/Carpenter), if recognised. */
  role: string | null;
  /** Role/trade exactly as written in the sheet, if any. */
  rawRole: string | null;
  /** Available/free capacity in hours, if a number was found. */
  availableHours: number | null;
  /** Assigned/planned hours, if a number was found. */
  assignedHours: number | null;
  /** Person/resource name, if any. */
  person: string | null;
}

/**
 * A best-effort structured view of one staffing/capacity sheet, kept alongside
 * the text chunks so capacity questions can use deterministic numbers instead of
 * re-parsing prose.
 */
export interface StructuredTable {
  sheetName: string;
  columns: StructuredColumns;
  rows: StructuredRow[];
}

/** A stored structured table with its owning-document identity. */
export interface StoredStructuredTable extends StructuredTable {
  documentId: string;
  documentName: string;
}

export interface ExtractedContent {
  fileType: SupportedFileType;
  segments: ExtractedSegment[];
  /** Present only for spreadsheets that look like a staffing/capacity plan. */
  structured?: StructuredTable[];
}

/** A stored chunk document under knowledge_documents/{id}/chunks/{chunkId}. */
export interface DocumentChunk {
  documentId: string;
  documentName: string;
  fileType: SupportedFileType;
  /** Sheet name for XLSX chunks; null otherwise (Firestore-friendly). */
  sheetName: string | null;
  chunkIndex: number;
  text: string;
  uploadedAt: string;
}

/** Metadata for a knowledge_documents/{id} document. */
export interface DocumentRecord {
  id: string;
  name: string;
  fileType: string;
  uploadedAt: string;
  chunkCount: number;
}

/** A chunk loaded back from storage for search. */
export interface StoredChunk {
  documentId: string;
  documentName: string;
  fileType: string;
  sheetName?: string;
  chunkIndex: number;
  text: string;
}

/** A compact reference to a used chunk (no chunk text) for API responses. */
export interface DocumentReference {
  documentId: string;
  documentName: string;
  fileType: string;
  sheetName?: string;
  chunkIndex: number;
}

/** Thrown when an unsupported file type is uploaded. */
export class UnsupportedFileTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileTypeError";
  }
}

/** Thrown when a supported file cannot be parsed. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}
