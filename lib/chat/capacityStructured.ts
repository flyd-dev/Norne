/**
 * Deterministic capacity readings from *structured* staffing-plan tables.
 *
 * When an uploaded XLSX looked like a staffing/capacity plan, the extractor kept
 * its rows as structured JSON (lib/documents/extract.ts). This module turns those
 * rows into reliable availability numbers — per role and per month — so capacity
 * questions are answered by arithmetic, not by the model guessing from prose.
 * Text-chunk scraping (lib/chat/capacityAnalysis.ts) remains the fallback when no
 * structured table exists.
 *
 * Pure and dependency-free for easy testing.
 */

import type { CanonicalRole } from "@/lib/chat/roles";
import type { StoredStructuredTable } from "@/lib/documents/types";

export interface MonthlyAvailability {
  month: string;
  /** Available hours per canonical role for the month. */
  byRole: Partial<Record<CanonicalRole, number>>;
  /** Total available hours across roles for the month. */
  total: number;
}

export interface StructuredAvailability {
  /** Total available hours per canonical role, summed across all rows. */
  byRole: Map<CanonicalRole, number>;
  /** Available hours per month (ordered as first seen), with per-role split. */
  byMonth: MonthlyAvailability[];
  /** Source document names the numbers were read from. */
  sources: string[];
  /** True when at least one available-hours number was found. */
  hasData: boolean;
}

function isCanonical(role: string | null): role is CanonicalRole {
  return role === "Welder" || role === "Steel fixer" || role === "Carpenter";
}

/**
 * Read available hours from structured staffing tables. Only rows with a numeric
 * `availableHours` contribute; rows missing a role/month still count toward the
 * role/month totals they do carry. Never invents numbers.
 */
export function readStructuredAvailability(
  tables: StoredStructuredTable[],
): StructuredAvailability {
  const byRole = new Map<CanonicalRole, number>();
  const monthOrder: string[] = [];
  const monthMap = new Map<string, MonthlyAvailability>();
  const sources = new Set<string>();
  let hasData = false;

  // Prefer tables that carry month-bearing availability rows (e.g. the
  // «Kapasitetsanalyse» sheet) over month-less total tables (e.g. a «Dashboard»
  // summary). When any monthly table exists, BOTH the per-role and per-month
  // numbers are read only from the monthly tables, so Dashboard totals can never
  // double-count the roles nor mask the structured monthly breakdown.
  const monthlyTables = tables.filter((table) =>
    table.rows.some(
      (row) =>
        Boolean(row.month && row.month.trim() !== "") &&
        row.availableHours !== null &&
        Number.isFinite(row.availableHours) &&
        row.availableHours > 0,
    ),
  );
  const source = monthlyTables.length > 0 ? monthlyTables : tables;

  for (const table of source) {
    for (const row of table.rows) {
      const hours = row.availableHours;
      if (hours === null || !Number.isFinite(hours) || hours <= 0) continue;
      hasData = true;
      sources.add(table.documentName);

      if (isCanonical(row.role)) {
        byRole.set(row.role, (byRole.get(row.role) ?? 0) + hours);
      }

      if (row.month) {
        let entry = monthMap.get(row.month);
        if (!entry) {
          entry = { month: row.month, byRole: {}, total: 0 };
          monthMap.set(row.month, entry);
          monthOrder.push(row.month);
        }
        entry.total += hours;
        if (isCanonical(row.role)) {
          entry.byRole[row.role] = (entry.byRole[row.role] ?? 0) + hours;
        }
      }
    }
  }

  return {
    byRole,
    byMonth: monthOrder.map((m) => monthMap.get(m)!),
    sources: [...sources],
    hasData,
  };
}
