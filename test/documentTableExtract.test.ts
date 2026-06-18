/**
 * T2.5: staffing/capacity tables embedded in PDF/DOCX text are detected as
 * structured tables (not just chunk text), while ordinary prose is not.
 */

import { describe, expect, it } from "vitest";
import { tablesFromText } from "@/lib/documents/extract";

describe("tablesFromText", () => {
  it("extracts a pipe-delimited capacity table", () => {
    const text = [
      "Kapasitetsanalyse for betong 2026",
      "",
      "Måned | Fag | Tilgjengelig | Tildelt",
      "september 2026 | Stålfikser | 31,5 | 20",
      "september 2026 | Tømrer | 57,8 | 20",
      "",
      "Med vennlig hilsen",
    ].join("\n");
    const tables = tablesFromText(text);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows.length).toBe(2);
    const first = tables[0].rows[0];
    expect(first.role).toBe("Steel fixer");
    expect(first.month).toBe("september 2026");
    expect(first.availableHours).toBe(31.5);
  });

  it("extracts a run-of-spaces aligned table", () => {
    const text = [
      "Måned        Fag          Tilgjengelig",
      "august 2026  Sveiser      15,8",
    ].join("\n");
    const tables = tablesFromText(text);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows[0].role).toBe("Welder");
    expect(tables[0].rows[0].availableHours).toBe(15.8);
  });

  it("does not invent a table from ordinary prose", () => {
    const text =
      "Dette er et vanlig avsnitt uten tabell. Det handler om HMS og verneutstyr på byggeplassen.";
    expect(tablesFromText(text)).toEqual([]);
  });

  it("ignores a non-staffing two-column block", () => {
    const text = ["Navn | Telefon", "Kari | 99887766", "Ola | 11223344"].join("\n");
    expect(tablesFromText(text)).toEqual([]);
  });
});
