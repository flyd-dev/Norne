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

import {
  CANONICAL_ROLES,
  findRoleMatches,
  type CanonicalRole,
} from "@/lib/chat/roles";
import { parseMonth } from "@/lib/chat/dateRange";
import type { StoredStructuredTable } from "@/lib/documents/types";
import type { DocumentMatch } from "@/lib/rag/documentSearch";

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

/** Matches a month name with an optional trailing 4-digit year, for the label. */
const MONTH_LABEL_RE =
  /\b(januar|january|februar|february|mars|march|april|mai|may|juni|june|juli|july|august|september|oktober|october|november|desember|december)\b(?:\s+(\d{4}))?/i;

/** Read a single hour figure from a text segment ("31.5", "1 200", "900,5"). */
function parseHourToken(text: string): number | null {
  const m = text.match(/\d[\d .]*(?:[.,]\d+)?/);
  if (!m) return null;
  // Drop spaces (thousands), and if a comma is the only separator treat it as a
  // decimal point. A dot is already a decimal point here.
  let token = m[0].replace(/\s+/g, "");
  if (!token.includes(".") && token.includes(",")) token = token.replace(",", ".");
  else token = token.replace(/,/g, "");
  const n = Number.parseFloat(token);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Deterministically read per-month, per-fag availability from staffing-plan
 * TEXT chunks (the «Kapasitetsanalyse» sheet) when no structured monthly rows
 * exist. Each line that names a month and one-or-more roles with an hour figure
 * is parsed — e.g. "September 2026: Steel fixer 31.5, Carpenter 57.8, Welder
 * 15.8" or a tab/space row "september  Stålfikser  900". Numbers are attributed
 * to the nearest preceding role on the line, so a multi-fag line yields one
 * entry per fag. Never invents numbers; lines without a month are ignored.
 *
 * This exists so a "frem til september 2026" answer carries September's per-fag
 * values deterministically instead of relying on the model to read the chunk —
 * the model has been observed to drop the last in-range month.
 */
export function readMonthlyAvailabilityFromText(
  chunks: Pick<DocumentMatch, "text" | "documentName">[],
): StructuredAvailability {
  const byRole = new Map<CanonicalRole, number>();
  const monthOrder: string[] = [];
  const monthMap = new Map<string, MonthlyAvailability>();
  const sources = new Set<string>();
  let hasData = false;

  for (const chunk of chunks) {
    for (const rawLine of chunk.text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const monthMatch = line.match(MONTH_LABEL_RE);
      if (!monthMatch || !parseMonth(monthMatch[0])) continue;

      // Strip the month label so its year can't be read as an hour figure, and
      // so role/number attribution starts after the month.
      const rest = line.slice((monthMatch.index ?? 0) + monthMatch[0].length);
      const roleMatches = findRoleMatches(rest);
      if (roleMatches.length === 0) continue;

      // Use a normalized lowercase month label as the key so the same month from
      // different chunks/overlaps merges instead of duplicating.
      const monthLabel = monthMatch[0].replace(/\s+/g, " ").trim().toLowerCase();

      for (let i = 0; i < roleMatches.length; i++) {
        const { role, end } = roleMatches[i];
        const windowEnd =
          i + 1 < roleMatches.length ? roleMatches[i + 1].index : rest.length;
        const hours = parseHourToken(rest.slice(end, windowEnd));
        if (hours === null) continue;

        hasData = true;
        sources.add(chunk.documentName);
        byRole.set(role, (byRole.get(role) ?? 0) + hours);

        let entry = monthMap.get(monthLabel);
        if (!entry) {
          entry = { month: monthLabel, byRole: {}, total: 0 };
          monthMap.set(monthLabel, entry);
          monthOrder.push(monthLabel);
        }
        // First value per (month, role) wins, so chunk overlaps don't double-count.
        if (entry.byRole[role] === undefined) {
          entry.byRole[role] = hours;
          entry.total += hours;
        }
      }
    }
  }

  // Recompute role totals from per-month entries so overlap dedupe is respected.
  byRole.clear();
  for (const m of monthOrder) {
    const entry = monthMap.get(m)!;
    for (const role of CANONICAL_ROLES) {
      const h = entry.byRole[role];
      if (h !== undefined) byRole.set(role, (byRole.get(role) ?? 0) + h);
    }
  }

  return {
    byRole,
    byMonth: monthOrder.map((m) => monthMap.get(m)!),
    sources: [...sources],
    hasData,
  };
}
