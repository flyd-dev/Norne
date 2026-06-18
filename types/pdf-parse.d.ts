// Minimal type declaration for the pdf-parse inner module (no bundled types).
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
  }
  export default function pdfParse(
    data: Buffer | Uint8Array,
  ): Promise<PdfParseResult>;
}
