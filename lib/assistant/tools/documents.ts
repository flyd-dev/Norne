/**
 * Document tool — searchUploadedDocuments.
 *
 * The ONLY tool that returns free-text chunks, and only when a question is
 * genuinely about document content (the runner decides that). It reads the
 * chunks already retrieved for the turn, optionally narrowed to one document,
 * and returns compact chunk references + text. Coverage "none" when empty.
 */

import type { DocumentMatch } from "@/lib/rag/documentSearch";
import {
  ok,
  none,
  type Tool,
  type ToolContext,
} from "@/lib/assistant/tools/registry";

export interface SearchDocumentsInput {
  query: string;
  /** Restrict to one document by (case-insensitive substring) name. */
  document?: string;
}

export interface DocumentHit {
  documentName: string;
  sheetName: string | null;
  chunkIndex: number;
  text: string;
}

export const searchUploadedDocuments: Tool<SearchDocumentsInput, DocumentHit[]> = {
  name: "searchUploadedDocuments",
  description:
    "Søk i opplastede dokumenter (PDF/Word/Excel-tekst). Bruk kun når svaret " +
    "faktisk er fritekst i et dokument, ikke for strukturerte tall.",
  validate: (raw) => {
    const input = raw as Partial<SearchDocumentsInput> | null;
    if (!input || typeof input.query !== "string") {
      return { ok: false, error: "query is required" };
    }
    return {
      ok: true,
      input: {
        query: input.query,
        ...(typeof input.document === "string" ? { document: input.document } : {}),
      },
    };
  },
  async run(input, ctx: ToolContext) {
    let matches: DocumentMatch[] = ctx.documentMatches ?? [];
    if (input.document) {
      const needle = input.document.toLowerCase();
      matches = matches.filter((m) => m.documentName.toLowerCase().includes(needle));
    }
    if (matches.length === 0) {
      return none("Fant ingen relevante dokumentutdrag.");
    }
    const hits: DocumentHit[] = matches.map((m) => ({
      documentName: m.documentName,
      sheetName: m.sheetName ?? null,
      chunkIndex: m.chunkIndex,
      text: m.text,
    }));
    const sources = [...new Set(matches.map((m) => m.documentName))];
    return ok(hits, sources);
  },
};
