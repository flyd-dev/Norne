/** Types for the document knowledge base (upload, extraction, chunking, storage). */

export const SUPPORTED_FILE_TYPES = ["pdf", "docx", "txt", "csv", "xlsx"] as const;
export type SupportedFileType = (typeof SUPPORTED_FILE_TYPES)[number];

/** One extracted text segment. For XLSX, one segment per sheet (with sheetName). */
export interface ExtractedSegment {
  sheetName?: string;
  text: string;
}

export interface ExtractedContent {
  fileType: SupportedFileType;
  segments: ExtractedSegment[];
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
