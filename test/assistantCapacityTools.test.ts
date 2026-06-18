/**
 * Tool-level tests for the capacity tools — the deterministic capacity facts the
 * assistant reasons over. Pins the live regression directly at the tool boundary:
 * "frem til september 2026" must INCLUDE September with its per-fag values,
 * exclude oktober–desember, and read from structured tables OR text chunks.
 */

import { describe, expect, it } from "vitest";
import type { StoredStructuredTable } from "@/lib/documents/types";
import type { DocumentMatch } from "@/lib/rag/documentSearch";
import { parseMonthRange } from "@/lib/chat/dateRange";
import {
  getMonthlyCapacity,
  getAvailableCapacity,
} from "@/lib/assistant/tools/capacity";
import type { ToolContext } from "@/lib/assistant/tools/registry";

const DOC = "bemanningsplan_ai_demo_betong_2026.xlsx";

function monthTable(month: string): StoredStructuredTable {
  const r = (role: "Steel fixer" | "Carpenter" | "Welder", hours: number) => ({
    month,
    role,
    rawRole: role,
    availableHours: hours,
    assignedHours: 20,
    person: null,
  });
  return {
    documentId: "D1",
    documentName: DOC,
    sheetName: "Kapasitetsanalyse",
    columns: {},
    rows: [r("Steel fixer", 31.5), r("Carpenter", 57.8), r("Welder", 15.8)],
  };
}

const ALL_MONTHS = [
  "juli 2026",
  "august 2026",
  "september 2026",
  "oktober 2026",
  "november 2026",
  "desember 2026",
];

function tablesCtx(): ToolContext {
  return { getStructuredTables: async () => ALL_MONTHS.map(monthTable) };
}

function textCtx(): ToolContext {
  const row = (m: string, fag: string, avail: string) =>
    `Måned: ${m} | Fag: ${fag} | Tilgjengelig: ${avail} | Tildelt: 20 | Navn: Per`;
  const lines = ["Ark: Kapasitetsanalyse"];
  for (const m of ALL_MONTHS) {
    lines.push(row(m, "Stålfikser", "31,5"));
    lines.push(row(m, "Tømrer", "57,8"));
    lines.push(row(m, "Sveiser", "15,8"));
  }
  const match = {
    documentId: "D1",
    documentName: DOC,
    fileType: "xlsx",
    sheetName: "Kapasitetsanalyse",
    chunkIndex: 0,
    score: 1,
    text: lines.join("\n"),
  } as DocumentMatch;
  return { documentMatches: [match] };
}

const UNTIL_SEPT = parseMonthRange("frem til september 2026")!;

describe("getMonthlyCapacity — inclusive 'frem til september 2026'", () => {
  for (const [label, ctx] of [
    ["structured tables", tablesCtx()],
    ["text chunks", textCtx()],
  ] as const) {
    it(`includes Jul/Aug/Sep with per-fag values, excludes okt–des (${label})`, async () => {
      const r = await getMonthlyCapacity.run({ bound: UNTIL_SEPT }, ctx);
      expect(r.coverage).toBe("full");
      const months = r.data!.months.map((m) => m.month);
      expect(months).toEqual(["2026-07", "2026-08", "2026-09"]);
      const sep = r.data!.months.find((m) => m.month === "2026-09")!;
      expect(sep.byRole["Steel fixer"]).toBe(31.5);
      expect(sep.byRole["Carpenter"]).toBe(57.8);
      expect(sep.byRole["Welder"]).toBe(15.8);
      expect(r.sources.join()).toContain(DOC);
      expect(r.sources.join()).toContain("Kapasitetsanalyse");
    });
  }

  it("returns coverage none when there is nothing to read", async () => {
    const r = await getMonthlyCapacity.run({ bound: UNTIL_SEPT }, {});
    expect(r.coverage).toBe("none");
    expect(r.data).toBeNull();
  });

  it("prefers the canonical getCapacityRows accessor when present", async () => {
    const ctx: ToolContext = {
      getCapacityRows: async () => [
        { month: "2026-09", role: "Welder", availableHours: 99, assignedHours: null, source: DOC, sheet: "Kapasitetsanalyse" },
      ],
      // A different structured table that must be IGNORED in favour of the rows.
      getStructuredTables: async () => ALL_MONTHS.map(monthTable),
    };
    const r = await getMonthlyCapacity.run({ bound: UNTIL_SEPT }, ctx);
    expect(r.coverage).toBe("full");
    expect(r.data!.months).toHaveLength(1);
    expect(r.data!.months[0].byRole["Welder"]).toBe(99);
  });

  it("returns coverage partial when data exists but not in range", async () => {
    const before = parseMonthRange("frem til januar 2025")!;
    const r = await getMonthlyCapacity.run({ bound: before }, tablesCtx());
    expect(r.coverage).toBe("partial");
    expect(r.data!.months).toEqual([]);
  });
});

describe("getAvailableCapacity — totals over the period", () => {
  it("sums per fag across the in-range months only", async () => {
    const r = await getAvailableCapacity.run({ bound: UNTIL_SEPT }, tablesCtx());
    expect(r.coverage).toBe("full");
    // 3 months (Jul/Aug/Sep) × per-fag value.
    expect(r.data!.byRole["Steel fixer"]).toBe(94.5);
    expect(r.data!.byRole["Carpenter"]).toBeCloseTo(173.4, 5);
    expect(r.data!.byRole["Welder"]).toBeCloseTo(47.4, 5);
  });

  it("can restrict to a single fag", async () => {
    const r = await getAvailableCapacity.run(
      { bound: UNTIL_SEPT, role: "Welder" },
      tablesCtx(),
    );
    expect(Object.keys(r.data!.byRole)).toEqual(["Welder"]);
    expect(r.data!.byRole["Welder"]).toBeCloseTo(47.4, 5);
  });
});
