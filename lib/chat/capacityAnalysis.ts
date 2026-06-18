/**
 * Deterministic capacity analysis layer.
 *
 * The *demand* side is computed reliably from the user's own question (total
 * hours × role percentages) — see lib/chat/capacity.ts. The *available* side is
 * best-effort: we scan the retrieved staffing-plan chunks for lines that pair a
 * role with an availability/capacity number. When we can read enough, we compute
 * a per-role gap; otherwise we hand the chunks to the model and say what is
 * missing. We never fabricate availability numbers.
 *
 * Pure and dependency-free for easy testing.
 */

import type { CapacityDemand, RoleDemand } from "@/lib/chat/capacity";
import { CANONICAL_ROLES, normalizeRole, type CanonicalRole } from "@/lib/chat/roles";

export interface RoleAvailability {
  role: CanonicalRole;
  hours: number;
}

export interface RoleGap {
  role: CanonicalRole;
  demand: number;
  available: number;
  /** available − demand: positive = surplus, negative = shortfall. */
  surplus: number;
}

export interface CapacityAnalysis {
  demand: RoleDemand[];
  totalDemandHours: number | null;
  startMonth: string | null;
  available: RoleAvailability[];
  gaps: RoleGap[];
  /** True when we could read at least one availability number from the plan. */
  hasAvailability: boolean;
  /** Where availability came from: structured rows, scraped text, or none. */
  availabilitySource: "structured" | "text" | "none";
}

/** Format an hour count with Norwegian thousands spacing: 8700 → "8 700". */
export function formatHours(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Keywords that mark a number as *available/free* capacity (not assigned). */
const AVAILABILITY_KEYWORDS =
  /(tilgjengelig|ledig|ledige|kapasitet|disponibel|available|free)/i;

/**
 * Best-effort: read available hours per role from staffing-plan chunk text.
 * Only counts a line that mentions exactly one role and an availability keyword
 * with a number — conservative on purpose, to avoid inventing figures.
 */
export function extractAvailableHours(
  chunks: { text: string }[],
): Map<CanonicalRole, number> {
  const totals = new Map<CanonicalRole, number>();

  for (const chunk of chunks) {
    for (const rawLine of chunk.text.split("\n")) {
      const line = rawLine.trim();
      if (!line || !AVAILABILITY_KEYWORDS.test(line)) continue;

      const role = normalizeRole(line);
      if (!role) continue;

      // Numbers on the line (allow "1 200" / "1.200" thousands grouping).
      const numbers = (line.match(/\d[\d.\s]*\d|\d/g) ?? [])
        .map((s) => Number.parseInt(s.replace(/[^\d]/g, ""), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (numbers.length === 0) continue;

      // The largest number on the line is the hour figure (others are weeks/ids).
      const hours = Math.max(...numbers);
      totals.set(role, (totals.get(role) ?? 0) + hours);
    }
  }

  return totals;
}

/**
 * Combine parsed demand with availability. Prefers a pre-computed availability
 * map read deterministically from structured staffing-plan rows; otherwise falls
 * back to best-effort scraping of the retrieved text chunks.
 */
export function analyzeCapacity(
  demand: CapacityDemand,
  chunks: { text: string }[],
  structuredAvailability?: Map<CanonicalRole, number>,
): CapacityAnalysis {
  const useStructured =
    structuredAvailability !== undefined && structuredAvailability.size > 0;
  const availableMap = useStructured
    ? structuredAvailability!
    : extractAvailableHours(chunks);

  const availabilitySource: CapacityAnalysis["availabilitySource"] = useStructured
    ? "structured"
    : availableMap.size > 0
      ? "text"
      : "none";

  const available: RoleAvailability[] = CANONICAL_ROLES.filter((r) =>
    availableMap.has(r),
  ).map((role) => ({ role, hours: availableMap.get(role)! }));

  const gaps: RoleGap[] = [];
  for (const d of demand.roles) {
    if (d.hours === null) continue;
    const avail = availableMap.get(d.role);
    if (avail === undefined) continue;
    gaps.push({
      role: d.role,
      demand: d.hours,
      available: avail,
      surplus: avail - d.hours,
    });
  }

  const totalDemandHours = demand.totalHours;

  return {
    demand: demand.roles,
    totalDemandHours,
    startMonth: demand.startMonth,
    available,
    gaps,
    hasAvailability: available.length > 0,
    availabilitySource,
  };
}

/**
 * Render a compact Norwegian note for the model: the deterministic demand
 * breakdown, any availability/gaps we could read, and explicit guidance when
 * the staffing plan lacks structured capacity numbers.
 */
export function formatCapacityNote(analysis: CapacityAnalysis): string {
  const lines: string[] = [];
  lines.push("Dette er et kapasitets-/bemanningsspørsmål. Bruk bemanningsplanen.");

  if (analysis.totalDemandHours !== null) {
    lines.push(
      `Etterspørsel for det nye prosjektet: totalt ${formatHours(
        analysis.totalDemandHours,
      )} timer${analysis.startMonth ? ` (start ${analysis.startMonth})` : ""}.`,
    );
  } else if (analysis.startMonth) {
    lines.push(`Oppstart: ${analysis.startMonth}.`);
  }

  if (analysis.demand.length > 0) {
    lines.push("Behov per fag:");
    for (const d of analysis.demand) {
      const hrs = d.hours !== null ? `${formatHours(d.hours)} timer` : "ukjent antall timer";
      lines.push(`- ${d.role}: ${d.percent}% = ${hrs}`);
    }
  }

  if (analysis.hasAvailability) {
    lines.push(
      analysis.availabilitySource === "structured"
        ? "Tilgjengelig kapasitet (lest fra strukturerte rader i bemanningsplanen):"
        : "Tilgjengelig kapasitet lest fra bemanningsplanen (ca.):",
    );
    for (const a of analysis.available) {
      lines.push(`- ${a.role}: ${formatHours(a.hours)} timer`);
    }
    if (analysis.gaps.length > 0) {
      lines.push("Differanse (tilgjengelig − behov):");
      for (const g of analysis.gaps) {
        const verdict = g.surplus >= 0 ? "overskudd" : "underskudd";
        lines.push(
          `- ${g.role}: ${formatHours(Math.abs(g.surplus))} timer ${verdict}`,
        );
      }
    }
    lines.push(
      "Konkluder per fag og totalt om dere har kapasitet eller må hente inn flere. " +
        "Tallene over er lest maskinelt fra planen — verifiser mot tallene i konteksten.",
    );
  } else {
    lines.push(
      "Jeg fant ikke entydige kapasitetstall (tilgjengelige timer per fag) i " +
        "bemanningsplanen. Les dokument-tekstene i konteksten: finnes tilgjengelige " +
        "timer/kapasitet per fag for perioden, bruk dem og konkluder. Finnes de ikke, " +
        "si tydelig hvilke tall som mangler for å kunne konkludere.",
    );
  }

  lines.push("Svar på norsk, kort og praktisk. Ikke ta med konto- eller prosjektoppsummeringer.");
  return lines.join("\n");
}
