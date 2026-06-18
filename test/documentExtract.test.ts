import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { extractText, fileTypeFromName } from "@/lib/documents/extract";
import { UnsupportedFileTypeError } from "@/lib/documents/types";

describe("fileTypeFromName", () => {
  it("recognises supported extensions", () => {
    expect(fileTypeFromName("a.PDF")).toBe("pdf");
    expect(fileTypeFromName("plan.xlsx")).toBe("xlsx");
    expect(fileTypeFromName("notes.txt")).toBe("txt");
  });

  it("throws for unsupported types", () => {
    expect(() => fileTypeFromName("image.png")).toThrow(UnsupportedFileTypeError);
    expect(() => fileTypeFromName("noext")).toThrow(UnsupportedFileTypeError);
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
