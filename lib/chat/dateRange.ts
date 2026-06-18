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
 * Canonical ISO month label "YYYY-MM" for a parsed (month, year), or null when
 * no year is known (ISO needs a year). This is the storage form for normalized
 * capacity rows — language-independent and sortable.
 */
export function toISOMonth(parsed: ParsedMonth): string | null {
  if (parsed.year === null) return null;
  return `${parsed.year}-${String(parsed.month).padStart(2, "0")}`;
}

/** Parse an ISO month label "YYYY-MM" back to (month, year), or null. */
export function parseISOMonth(iso: string): ParsedMonth | null {
  const m = iso.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const month = Number.parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return { month, year: Number.parseInt(m[1], 10) };
}

/**
 * Parse a month from EITHER an ISO label ("2026-09") or free text ("september
 * 2026" / "Aug."). Lets callers store ISO yet still match name-bearing input.
 */
export function parseAnyMonth(text: string): ParsedMonth | null {
  return parseISOMonth(text) ?? parseMonth(text);
}

/** True when a parsed (month, year) falls INSIDE the bound (inclusive per kind). */
export function isMonthInBound(parsed: ParsedMonth, bound: MonthBound): boolean {
  return !isMonthOutsideBound(parsed.month, parsed.year, bound);
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

/** True when a single (month, year) falls OUTSIDE the bound. */
function isMonthOutsideBound(
  month: number,
  year: number | null,
  bound: MonthBound,
): boolean {
  const refYear = bound.year;
  const boundKey = key(bound.month, bound.year, refYear);
  const cellKey = key(month, year, refYear);
  switch (bound.kind) {
    case "upTo":
      return cellKey > boundKey;
    case "from":
      return cellKey < boundKey;
    case "after":
      return cellKey <= boundKey;
  }
}

/** Matches a month name with an optional trailing 4-digit year. */
const MONTH_WITH_YEAR_RE = new RegExp(
  `\\b(${MONTH_ALT})\\b(?:\\s+(\\d{4}))?`,
  "gi",
);

/** Classify whether a text segment names months inside / outside the bound. */
function classifyMonths(
  text: string,
  bound: MonthBound,
): { hasIn: boolean; hasOut: boolean } {
  let hasIn = false;
  let hasOut = false;
  for (const m of text.matchAll(MONTH_WITH_YEAR_RE)) {
    const month = MONTH_INDEX[m[1].toLowerCase()];
    if (!month) continue;
    const year = m[2] ? Number(m[2]) : null;
    if (isMonthOutsideBound(month, year, bound)) hasOut = true;
    else hasIn = true;
  }
  return { hasIn, hasOut };
}

/** Remove out-of-period month tokens (and their list separators) from a mixed
 * segment, leaving in-period months and surrounding text intact. */
function stripOutOfPeriodTokens(text: string, bound: MonthBound): string {
  // Match an out-of-period month with optional adjacent list separators
  // (", " / " og ") so the separator is removed along with the month.
  const re = new RegExp(
    `(\\s*(?:,|\\bog\\b)\\s*)?\\b(${MONTH_ALT})\\b(?:\\s+(\\d{4}))?(\\s*(?:,|\\bog\\b)\\s*)?`,
    "gi",
  );
  const stripped = text.replace(re, (full, before, name, year, after) => {
    const month = MONTH_INDEX[String(name).toLowerCase()];
    if (!month) return full;
    const y = year ? Number(year) : null;
    if (!isMonthOutsideBound(month, y, bound)) return full;
    // Keep a single separator only when the month sat between two kept items.
    return before && after ? before : "";
  });
  return stripped
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/**
 * Belt-and-braces deterministic scrub for monthly-capacity answers: even with
 * the prompt guardrail, raw document chunks can leak months OUTSIDE the
 * requested range into the model's draft (e.g. "disse månedene mangler:
 * oktober, november og desember" for a "frem til september" request). Drop any
 * sentence/line segment that names an out-of-period month; when a segment mixes
 * in- and out-of-period months, keep it and strip only the out-of-period tokens.
 *
 * Leaves in-period months, filenames, sheet/source labels and unrelated text
 * untouched — it only acts on segments that actually name an out-of-period month.
 */
export function scrubOutOfPeriodMonths(answer: string, bound: MonthBound): string {
  const cleanedLines = answer.split("\n").map((line) => {
    // Split into sentence-like segments on terminators, keeping the delimiter.
    const segments = line.split(/(?<=[.!?])\s+/);
    const kept = segments
      .map((seg) => {
        const { hasIn, hasOut } = classifyMonths(seg, bound);
        if (!hasOut) return seg; // nothing out-of-period: leave as-is
        if (!hasIn) return null; // purely out-of-period: drop the segment
        return stripOutOfPeriodTokens(seg, bound); // mixed: strip the bad tokens
      })
      .filter((seg): seg is string => seg !== null && seg.trim() !== "");
    return kept.join(" ");
  });

  // Drop lines emptied by the scrub, and collapse the blank runs they leave.
  const out: string[] = [];
  for (const line of cleanedLines) {
    if (line.trim() === "") {
      if (out.length === 0 || out[out.length - 1].trim() === "") continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}
