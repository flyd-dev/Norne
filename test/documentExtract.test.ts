import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import AdmZip from "adm-zip";
import { extractText, fileTypeFromName } from "@/lib/documents/extract";
import { UnsupportedFileTypeError } from "@/lib/documents/types";

// .msg is a binary OLE format that's impractical to build in a test — mock the
// reader so we can verify our wiring (subject/sender/body → text).
vi.mock("@kenjiuno/msgreader", () => ({
  default: class {
    getFileData() {
      return {
        subject: "Tilbud Nornebygg",
        senderName: "Kari Nordmann",
        body: "Hei, her er tilbudet på betongarbeidet.",
      };
    }
  },
}));

/** Build a minimal valid PPTX (zip) with the given text runs per slide. */
function makePptx(slides: string[][]): Buffer {
  const zip = new AdmZip();
  slides.forEach((runs, i) => {
    const body = runs.map((t) => `<a:t>${t}</a:t>`).join("");
    const xml = `<?xml version="1.0"?><p:sld xmlns:a="x"><p:cSld><a:p>${body}</a:p></p:cSld></p:sld>`;
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(xml, "utf8"));
  });
  return zip.toBuffer();
}

describe("fileTypeFromName", () => {
  it("recognises supported extensions", () => {
    expect(fileTypeFromName("a.PDF")).toBe("pdf");
    expect(fileTypeFromName("plan.xlsx")).toBe("xlsx");
    expect(fileTypeFromName("notes.txt")).toBe("txt");
    expect(fileTypeFromName("deck.pptx")).toBe("pptx");
    expect(fileTypeFromName("epost.MSG")).toBe("msg");
  });

  it("throws for unsupported types", () => {
    expect(() => fileTypeFromName("image.png")).toThrow(UnsupportedFileTypeError);
    expect(() => fileTypeFromName("noext")).toThrow(UnsupportedFileTypeError);
  });
});

describe("extractText — pptx & msg", () => {
  it("extracts slide text from a PPTX, in slide order", async () => {
    const buf = makePptx([
      ["Tilbud", "Nornebygg"],
      ["Pris og fremdrift"],
    ]);
    const content = await extractText(buf, "presentasjon.pptx");
    expect(content.fileType).toBe("pptx");
    expect(content.segments[0].text).toContain("Tilbud Nornebygg");
    expect(content.segments[0].text).toContain("Pris og fremdrift");
  });

  it("extracts subject, sender and body from a MSG", async () => {
    const content = await extractText(Buffer.from("ole-binary"), "epost.msg");
    expect(content.fileType).toBe("msg");
    expect(content.segments[0].text).toContain("Tilbud Nornebygg");
    expect(content.segments[0].text).toContain("Kari Nordmann");
    expect(content.segments[0].text).toContain("betongarbeidet");
  });
});

describe("extractText", () => {
  it("extracts plain TXT", async () => {
    const buf = Buffer.from("Hei verden\nLinje to", "utf8");
    const content = await extractText(buf, "notes.txt");
    expect(content.fileType).toBe("txt");
    expect(content.segments[0].text).toContain("Hei verden");
  });

  it("converts CSV rows into readable header: value text", async () => {
    const csv = "navn,rolle\nKari,Bas\nOla,Montør";
    const content = await extractText(Buffer.from(csv, "utf8"), "folk.csv");
    expect(content.fileType).toBe("csv");
    const text = content.segments[0].text;
    expect(text).toContain("navn: Kari");
    expect(text).toContain("rolle: Bas");
    expect(text).toContain("navn: Ola");
  });

  it("extracts each XLSX sheet with sheet name, headers and values", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["navn", "uke"],
      ["Kari", 12],
      ["Ola", 13],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Bemanning");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const content = await extractText(buf, "bemanningsplan.xlsx");
    expect(content.fileType).toBe("xlsx");
    expect(content.segments).toHaveLength(1);
    expect(content.segments[0].sheetName).toBe("Bemanning");
    expect(content.segments[0].text).toContain("Ark: Bemanning");
    expect(content.segments[0].text).toContain("navn: Kari");
    expect(content.segments[0].text).toContain("uke: 12");
  });

  it("rejects unsupported file types", async () => {
    await expect(extractText(Buffer.from("x"), "logo.png")).rejects.toThrow(
      UnsupportedFileTypeError,
    );
  });
});
