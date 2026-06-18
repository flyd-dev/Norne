/**
 * Capacity / staffing-plan intent + demand parsing.
 *
 * Recognises operational questions about whether a crew has capacity for a new
 * project ("Har vi kapasitet eller må vi hente inn flere folk?") and extracts the
 * project demand from the question itself:
 *
 *   - total hours          "Ca. 29.000 timer"        → 29000
 *   - start month          "starte i august"         → "august"
 *   - role distribution    "30% Welder, 20% Stilfixer og resterende Carpenter"
 *                          → Welder 30% (8700t), Steel fixer 20% (5800t),
 *                            Carpenter 50% (14500t)
 *
 * Pure and dependency-free. The orchestrator decides how to use the result; this
 * module only classifies and parses.
 */

import {
  ALL_ROLE_TERMS,
  CANONICAL_ROLES,
  normalizeRole,
  type CanonicalRole,
} from "@/lib/chat/roles";

/** Hours demanded for one role on the planned project. */
export interface RoleDemand {
  role: CanonicalRole;
  /** Share of the total, 0–100. */
  percent: number;
  /** Demand in hours, when a total is known; otherwise null. */
  hours: number | null;
}

export interface CapacityDemand {
  /** Total project hours, e.g. 29000; null when not stated. */
  totalHours: number | null;
  /** Canonical Norwegian start month (e.g. "august"); null when not stated. */
  startMonth: string | null;
  /** Per-role demand, ordered by canonical role. */
  roles: RoleDemand[];
}

/** General capacity/staffing vocabulary (besides role names and months). */
const CAPACITY_TERMS = [
  "bemanningsplan",
  "bemanning",
  "kapasitet",
  "hente inn flere",
  "trenger vi flere",
  "flere folk",
  "nok folk",
  "ressurs",
  "ressurser",
  "tilgjengelige timer",
  "tilgjengelig",
  "ledig kapasitet",
  "rotasjonsplan",
  "fordeling",
  "bemanne",
  "underbemann",
  "overbemann",
];

/** Canonical Norwegian months, plus English aliases mapped onto them. */
const MONTHS: Record<string, string> = {
  januar: "januar",
  january: "januar",
  februar: "februar",
  february: "februar",
  mars: "mars",
  march: "mars",
  april: "april",
  mai: "mai",
  may: "mai",
  juni: "juni",
  june: "juni",
  juli: "juli",
  july: "juli",
  august: "august",
  september: "september",
  oktober: "oktober",
  october: "oktober",
  november: "november",
  desember: "desember",
  december: "desember",
};

const MONTH_RE = new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\b`, "i");

/**
 * True when the message is about staffing/capacity — capacity vocabulary, a
 * month + hours combination, or a role distribution. Deliberately broad: the
 * cost of a false positive (searching the staffing plan) is low; the cost of a
 * false negative (refusing to look) is exactly the bug we are fixing.
 */
export function detectCapacityIntent(message: string): boolean {
  const lower = message.toLowerCase();
  if (CAPACITY_TERMS.some((t) => lower.includes(t))) return true;
  if (ALL_ROLE_TERMS.some((t) => lower.includes(t))) return true;
  // "timer" combined with a month or a percentage distribution is a planning Q.
  const hasHours = /\btimer?\b/i.test(lower);
  if (hasHours && (MONTH_RE.test(lower) || /\d{1,3}\s*%/.test(lower))) return true;
  return false;
}

/** Parse "29.000 timer" / "29 000 timer" / "29000 timer" → 29000. */
function parseTotalHours(message: string): number | null {
  // A number (allowing "." or space thousand separators) right before "timer".
  const m = message.match(/(\d[\d.\s ]*\d|\d)\s*(?:timer|time)\b/i);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, "");
  if (digits.length === 0) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

/** Parse the start month, if stated. */
function parseStartMonth(message: string): string | null {
  const m = message.match(MONTH_RE);
  if (!m) return null;
  return MONTHS[m[1].toLowerCase()] ?? null;
}

/**
 * Parse explicit "<pct>% <role>" pairs and a trailing "resterende <role>".
 * Returns a percent per canonical role, distributing the remainder to the
 * "resterende"/"resten" role when present.
 */
function parseRolePercentages(message: string): Map<CanonicalRole, number> {
  const percents = new Map<CanonicalRole, number>();

  // "30% Welder", "20 % Stilfixer", up to the next comma / "og" / "eller" / end.
  const explicit = /(\d{1,3})\s*%\s*([^,.\d]+?)(?=,|\.|\s+og\b|\s+eller\b|$)/gi;
  let explicitSum = 0;
  for (const match of message.matchAll(explicit)) {
    const pct = Number.parseInt(match[1], 10);
    const role = normalizeRole(match[2]);
    if (role && Number.isFinite(pct)) {
      percents.set(role, (percents.get(role) ?? 0) + pct);
      explicitSum += pct;
    }
  }

  // "resterende Carpenter" / "resten er Tømrer" / "øvrige Carpenter".
  const remainingMatch = message.match(
    /\b(?:resterende|resten(?:\s+er)?|(?:de\s+)?øvrige?)\s+([^,.\d]+?)(?=,|\.|\s+og\b|$)/i,
  );
  if (remainingMatch) {
    const role = normalizeRole(remainingMatch[1]);
    const remaining = 100 - explicitSum;
    if (role && remaining > 0 && !percents.has(role)) {
      percents.set(role, remaining);
    }
  }

  return percents;
}

/**
 * Parse project demand from a capacity question. Returns null when nothing
 * usable (no hours, month, or role distribution) was found.
 */
export function parseCapacityDemand(message: string): CapacityDemand | null {
  const totalHours = parseTotalHours(message);
  const startMonth = parseStartMonth(message);
  const percents = parseRolePercentages(message);

  const roles: RoleDemand[] = CANONICAL_ROLES.filter((r) => percents.has(r)).map(
    (role) => {
      const percent = percents.get(role)!;
      const hours =
        totalHours !== null ? Math.round((totalHours * percent) / 100) : null;
      return { role, percent, hours };
    },
  );

  if (totalHours === null && startMonth === null && roles.length === 0) {
    return null;
  }

  return { totalHours, startMonth, roles };
}
