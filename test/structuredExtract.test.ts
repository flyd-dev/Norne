import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { extractText } from "@/lib/documents/extract";
import { readStructuredAvailability } from "@/lib/chat/capacityStructured";
import type { StoredStructuredTable } from "@/lib/documents/types";

/** Build an .xlsx buffer with one staffing-plan-like sheet. */
function staffingWorkbook(): Buffer {
  const aoa = [
    ["Måned", "Fag", "Tilgjengelig timer", "Tildelt timer", "Navn"],
    ["august", "Sveiser", "1 200", "800", "Ola"],
    ["august", "Tømrer", "2 000", "1 500", "Kari"],
    ["september", "Stålfikser", "900", "400", "Per"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Kapasitetsanalyse");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("structured staffing-plan extraction", () => {
  it("parses a staffing sheet into structured rows with mapped columns", async () => {
    const content = await extractText(staffingWorkbook(), "bemanningsplan.xlsx");
    expect(content.structured).toBeDefined();
    const table = content.structured![0];
    expect(table.sheetName).toBe("Kapasitetsanalyse");
    expect(table.columns.month).toBeDefined();
    expect(table.columns.role).toBeDefined();
    expect(table.columns.availableHours).toBeDefined();
    expect(table.columns.assignedHours).toBeDefined();
    expect(table.rows.length).toBe(3);
  });

  it("canonicalizes roles and parses Norwegian number formatting", async () => {
    const content = await extractText(staffingWorkbook(), "bemanningsplan.xlsx");
    const rows = content.structured![0].rows;
    const welder = rows.find((r) => r.role === "Welder");
    expect(welder?.availableHours).toBe(1200);
    expect(welder?.month).toBe("august");
    expect(rows.find((r) => r.role === "Carpenter")?.availableHours).toBe(2000);
    expect(rows.find((r) => r.role === "Steel fixer")?.availableHours).toBe(900);
  });

  it("still produces text segments alongside the structured table", async () => {
    const content = await extractText(staffingWorkbook(), "bemanningsplan.xlsx");
    expect(content.segments.length).toBeGreaterThan(0);
    expect(content.segments[0].text).toMatch(/Kapasitetsanalyse/);
  });

  it("leaves a non-staffing spreadsheet without structured tables", async () => {
    const aoa = [
      ["Produkt", "Pris"],
      ["Spiker", "10"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Prisliste");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const content = await extractText(buf, "prisliste.xlsx");
    expect(content.structured).toBeUndefined();
  });
});

describe("readStructuredAvailability", () => {
  it("aggregates available hours per role and per month", async () => {
    const content = await extractText(staffingWorkbook(), "bemanningsplan.xlsx");
    const tables: StoredStructuredTable[] = content.structured!.map((t) => ({
      ...t,
      documentId: "DOC1",
      documentName: "bemanningsplan.xlsx",
    }));

    const avail = readStructuredAvailability(tables);
    expect(avail.hasData).toBe(true);
    expect(avail.byRole.get("Welder")).toBe(1200);
    expect(avail.byRole.get("Carpenter")).toBe(2000);
    expect(avail.byRole.get("Steel fixer")).toBe(900);

    const months = avail.byMonth.map((m) => m.month);
    expect(months).toEqual(["august", "september"]);
    const august = avail.byMonth.find((m) => m.month === "august")!;
    expect(august.total).toBe(3200); // 1200 + 2000
    expect(avail.sources).toContain("bemanningsplan.xlsx");
  });

  it("returns no data for empty input without inventing numbers", () => {
    const avail = readStructuredAvailability([]);
    expect(avail.hasData).toBe(false);
    expect(avail.byMonth).toEqual([]);
  });
});
