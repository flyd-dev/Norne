/**
 * Canonical capacity domain model.
 *
 * One source of truth for "available capacity per fag per måned", independent of
 * where it was read from (a structured XLSX sheet, or text chunks). The month is
 * a language-independent ISO label ("2026-09") when a year is known, falling
 * back to the raw lowercased month name only when the source omitted the year.
 *
 * Tools return these objects; the model never sees raw spreadsheet cells.
 */

import type { CanonicalRole } from "@/lib/chat/roles";

export interface CapacityRow {
  /** ISO month "YYYY-MM" when a year is known, else the lowercased month name. */
  month: string;
  role: CanonicalRole;
  availableHours: number;
  assignedHours: number | null;
  /** Document the figure was read from, e.g. "bemanningsplan_...xlsx". */
  source: string;
  /** Sheet the figure was read from, e.g. "Kapasitetsanalyse". */
  sheet: string | null;
}

/** Availability for one month, rolled up per fag with a total. */
export interface MonthlyCapacity {
  month: string;
  byRole: Partial<Record<CanonicalRole, number>>;
  total: number;
}
