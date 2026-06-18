/**
 * Regression for the LIVE workbook header shape (bemanningsplan_ai_demo_betong
 * _2026.xlsx / Kapasitetsanalyse): the role column is "Arbeidstype" and the
 * available column is "Teoretisk tilgjengelig 6/2". Before the fix, "Arbeidstype"
 * was not recognised as a role, so every row parsed with role=null and the
 * capacity rows were dropped — capacity then fell back to scraping the
 * Rotasjonsplan text and summed week-start serials into millions.
 *
 * This pins the exact real headers so that can never silently regress.
 */

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { extractText } from "@/lib/documents/extract";
import { capacityRowsFromTables } from "@/lib/assistant/ingestion/capacity";
import type { StoredStructuredTable } from "@/lib/documents/types";

function buildWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Måned", "Arbeidstype", "Planlagt behov", "Teoretisk tilgjengelig 6/2", "Gap (+/-)", "Utnyttelse"],
    ["2026-07", "Steel fixer", "32", "31.5", "-0.5", "1.02"],
    ["2026-07", "Carpenter", "61", "57.8", "-3.2", "1.06"],
    ["2026-07", "Welder", "15", "15.8", "0.8", "0.95"],
    ["2026-08", "Steel fixer", "28", "31.5", "3.5", "0.89"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Kapasitetsanalyse");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("real Kapasitetsanalyse header shape", () => {
  it("recognises Arbeidstype as the role column and Teoretisk tilgjengelig as available", async () => {
    const content = await extractText(buildWorkbook(), "bemanningsplan.xlsx");
    const table = content.structured?.[0];
    expect(table?.columns.role).toBe("Arbeidstype");
    expect(table?.columns.availableHours).toBe("Teoretisk tilgjengelig 6/2");
    // Every data row now carries a canonical role (not null).
    expect(table?.rows.every((r) => r.role !== null)).toBe(true);
  });

  it("produces canonical CapacityRows with the per-fag available figures", async () => {
    const content = await extractText(buildWorkbook(), "bemanningsplan.xlsx");
    const tables: StoredStructuredTable[] = (content.structured ?? []).map((t) => ({
      ...t,
      documentId: "D1",
      documentName: "bemanningsplan.xlsx",
    }));
    const rows = capacityRowsFromTables(tables);
    expect(rows.length).toBe(4);
    const julSteel = rows.find((r) => r.month === "2026-07" && r.role === "Steel fixer");
    expect(julSteel?.availableHours).toBe(31.5);
    const julCarp = rows.find((r) => r.month === "2026-07" && r.role === "Carpenter");
    expect(julCarp?.availableHours).toBe(57.8);
  });
});
