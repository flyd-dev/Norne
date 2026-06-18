/**
 * Text chunking. Pure and dependency-free for easy testing.
 *
 * Splits text into ~800–1200 char chunks with ~150–250 char overlap, preferring
 * to break on whitespace near the boundary so chunks don't cut mid-word.
 */

import type {
  DocumentChunk,
  ExtractedContent,
  SupportedFileType,
} from "@/lib/documents/types";

export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 200;

export interface ChunkOptions {
  size?: number;
  overlap?: number;
}

/** Split a single string into overlapping chunks. */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = options.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = Math.min(options.overlap ?? DEFAULT_CHUNK_OVERLAP, size - 1);
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length === 0) return [];
  if (clean.length <= size) return [clean];

  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);

    // Prefer to end on a whitespace boundary within the last ~15% of the window.
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const lastBreak = Math.max(
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf(" "),
      );
      if (lastBreak > size * 0.85) {
        end = start + lastBreak + 1;
      }
    }

    const piece = clean.slice(start, end).trim();
    if (piece.length > 0) chunks.push(piece);

    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + step);
  }

  return chunks;
}

/**
 * Build stored chunks (with metadata) from extracted content. chunkIndex is a
 * single sequence across all segments; sheetName is carried per segment.
 */
export function buildChunks(
  content: ExtractedContent,
  meta: {
    documentId: string;
    documentName: string;
    uploadedAt: string;
  },
  options: ChunkOptions = {},
): DocumentChunk[] {
  const fileType: SupportedFileType = content.fileType;
  const out: DocumentChunk[] = [];
  let index = 0;

  for (const segment of content.segments) {
    for (const text of chunkText(segment.text, options)) {
      out.push({
        documentId: meta.documentId,
        documentName: meta.documentName,
        fileType,
        sheetName: segment.sheetName ?? null,
        chunkIndex: index++,
        text,
        uploadedAt: meta.uploadedAt,
      });
    }
  }

  return out;
}
