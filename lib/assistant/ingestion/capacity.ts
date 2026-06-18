/**
 * Ingestion: raw staffing data → canonical CapacityRow[].
 *
 * Two inputs, one output shape:
 *   - structured XLSX tables (StoredStructuredTable, parsed at upload), and
 *   - staffing-plan text chunks (the «Kapasitetsanalyse» sheet as prose),
 * are both normalized into CapacityRow with an ISO month. The tool layer reads
 * CapacityRow only, so capacity answers never depend on month wording again.
 *
 * Structured rows win when present; the text path is the fallback for workbooks
 * whose month column didn't parse into structured rows.
 *
 * Pure and dependency-free.
 */

import { parseMonth, toISOMonth } from "@/lib/chat/dateRange";
import { readMonthlyAvailabilityFromText } from "@/lib/chat/capacityStructured";
import type { CanonicalRole } from "@/lib/chat/roles";
import type { StoredStructuredTable } from "@/lib/documents/types";
import type { DocumentMatch } from "@/lib/rag/documentSearch";
import type { CapacityRow } from "@/lib/assistant/domain/capacity";

function isCanonical(role: string | null): role is CanonicalRole {
  return role === "Welder" || role === "Steel fixer" || role === "Carpenter";
}

/** Normalize a raw month cell ("september 2026", "Aug.") to an ISO label, or
 * fall back to the lowercased name when no year is present. */
function normalizeMonth(raw: string): string {
  const parsed = parseMonth(raw);
  if (!parsed) return raw.trim().toLowerCase();
  return toISOMonth(parsed) ?? raw.trim().toLowerCase();
}

/**
 * CapacityRow[] from structured staffing tables. Mirrors the month-bearing-table
 * preference used elsewhere: when any table carries month+hours rows, ONLY those
 * tables contribute, so a month-less Dashboard totals sheet can't double-count.
 */
export function capacityRowsFromTables(
  tables: StoredStructuredTable[],
): CapacityRow[] {
  const monthlyTables = tables.filter((t) =>
    t.rows.some(
      (r) =>
        Boolean(r.month && r.month.trim() !== "") &&
        r.availableHours !== null &&
        Number.isFinite(r.availableHours) &&
        r.availableHours > 0,
    ),
  );
  const source = monthlyTables.length > 0 ? monthlyTables : tables;

  const rows: CapacityRow[] = [];
  for (const table of source) {
    for (const row of table.rows) {
      const hours = row.availableHours;
      if (hours === null || !Number.isFinite(hours) || hours <= 0) continue;
      if (!row.month || !isCanonical(row.role)) continue;
      rows.push({
        month: normalizeMonth(row.month),
        role: row.role,
        availableHours: hours,
        assignedHours: row.assignedHours,
        source: table.documentName,
        sheet: table.sheetName,
      });
    }
  }
  return rows;
}

/**
 * CapacityRow[] from staffing-plan text chunks, via the deterministic per-fag
 * per-month text reader. Months are normalized to ISO; assigned hours are not
 * available from text so they stay null.
 */
export function capacityRowsFromText(
  chunks: Pick<DocumentMatch, "text" | "documentName" | "sheetName">[],
): CapacityRow[] {
  const avail = readMonthlyAvailabilityFromText(chunks);
  // Map document → sheet so a CapacityRow can name the sheet it came from.
  const sheetByDoc = new Map<string, string | null>();
  for (const c of chunks) {
    if (!sheetByDoc.has(c.documentName)) {
      sheetByDoc.set(c.documentName, c.sheetName ?? null);
    }
  }
  const source = avail.sources[0] ?? "";
  const rows: CapacityRow[] = [];
  for (const m of avail.byMonth) {
    for (const [role, hours] of Object.entries(m.byRole)) {
      if (hours === undefined) continue;
      rows.push({
        month: normalizeMonth(m.month),
        role: role as CanonicalRole,
        availableHours: hours,
        assignedHours: null,
        source,
        sheet: sheetByDoc.get(source) ?? "Kapasitetsanalyse",
      });
    }
  }
  return rows;
}
