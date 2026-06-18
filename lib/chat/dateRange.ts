/**
 * Deterministic Norwegian month-range parsing and filtering.
 *
 * Time-range follow-ups ("frem til september 2026", "fra august", "etter mai")
 * must NOT be left to the model — it reverses them ("frem til september" became
 * September–December). This module parses the range bound and filters a list of
 * month cells deterministically, so the answer can only contain the months that
 * are actually inside the requested range.
 *
 * Norwegian semantics (the whole point of this module):
 *   - "frem/fram til <måned>"      → up to AND INCLUDING that month
 *   - "til og med <måned>"         → up to AND INCLUDING that month
 *   - "fra (og med) <måned>"       → from that month onwards (inclusive)
 *   - "etter <måned>"              → strictly after that month
 *
 * Pure and dependency-free for easy testing.
 */

/** Canonical Norwegian month → 1-based index, plus English aliases. */
const MONTH_INDEX: Record<string, number> = {
  januar: 1,
  january: 1,
  februar: 2,
  february: 2,
  mars: 3,
  march: 3,
  april: 4,
  mai: 5,
  may: 5,
  juni: 6,
  june: 6,
  juli: 7,
  july: 7,
  august: 8,
  september: 9,
  oktober: 10,
  october: 10,
  november: 11,
  desember: 12,
  december: 12,
};

const MONTH_NAMES = Object.keys(MONTH_INDEX);
const MONTH_ALT = MONTH_NAMES.join("|");
const MONTH_TOKEN_RE = new RegExp(`\\b(${MONTH_ALT})\\b`, "i");

/** How a stated bound constrains a month list. */
export type RangeKind = "upTo" | "from" | "after";

export interface MonthBound {
  kind: RangeKind;
  /** 1-based month index (1 = januar). */
  month: number;
  /** Four-digit year when stated, else null. */
  year: number | null;
}

export interface ParsedMonth {
  month: number;
  year: number | null;
}

/**
 * Parse the first month (and optional 4-digit year) from a free-text cell or
 * phrase, e.g. "september 2026" → { month: 9, year: 2026 }, "Aug." → month 8.
 * Returns null when no month name is present.
 */
export function parseMonth(text: string): ParsedMonth | null {
  if (!text) return null;
  const m = text.match(MONTH_TOKEN_RE);
  if (!m) return null;
  const month = MONTH_INDEX[m[1].toLowerCase()];
  if (!month) return null;
  // A 4-digit year anywhere in the cell (2000–2099 range is plenty here).
  const yearMatch = text.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;
  return { month, year };
}

/** Direction phrases, most specific first. */
const RANGE_PATTERNS: { re: RegExp; kind: RangeKind }[] = [
  { re: /\btil\s+og\s+med\b/i, kind: "upTo" },
  { re: /\b(?:fram|frem)\s+til\b/i, kind: "upTo" },
  { re: /\bt\.?o\.?m\.?\b/i, kind: "upTo" },
  { re: /\bfra\s+og\s+med\b/i, kind: "from" },
  { re: /\bf\.?o\.?m\.?\b/i, kind: "from" },
  { re: /\bfra\b/i, kind: "from" },
  { re: /\better\b/i, kind: "after" },
];

/**
 * Parse a month-range bound from a message. Looks for a direction phrase and
 * takes the first month that appears AFTER it (so "fra august frem til oktober"
 * is handled by the most specific phrase the caller cares about — here the first
 * matching pattern wins). Returns null when no bound is expressed.
 */
export function parseMonthRange(text: string): MonthBound | null {
  for (const { re, kind } of RANGE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const after = text.slice(m.index + m[0].length);
    const parsed = parseMonth(after);
    if (parsed) {
      return { kind, month: parsed.month, year: parsed.year };
    }
  }
  return null;
}

/** Sortable key for (month, year). Cells lacking a year inherit the bound's. */
function key(month: number, year: number | null, refYear: number | null): number {
  const y = year ?? refYear ?? 0;
  return y * 12 + month;
}

/**
 * Filter a list of month-bearing rows to those inside the bound. Rows whose
 * month cell cannot be parsed are dropped (we never show a month we can't place
 * inside the requested range). Keeps input order.
 */
export function filterMonthsByBound<T extends { month: string }>(
  rows: T[],
  bound: MonthBound,
): T[] {
  const refYear = bound.year;
  const boundKey = key(bound.month, bound.year, refYear);
  return rows.filter((row) => {
    const parsed = parseMonth(row.month);
    if (!parsed) return false;
    const cellKey = key(parsed.month, parsed.year, refYear);
    switch (bound.kind) {
      case "upTo":
        return cellKey <= boundKey;
      case "from":
        return cellKey >= boundKey;
      case "after":
        return cellKey > boundKey;
    }
  });
}
