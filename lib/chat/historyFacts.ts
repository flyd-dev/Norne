/**
 * Extract facts already established in recent conversation history.
 *
 * A capable assistant should not re-discover what it just said. When an earlier
 * turn established a project ("Prosjektnummer: 7100", "Prosjektnavn: Pilestredet")
 * or a metric value ("Kontraktsverdi: 150 705 668"), an elliptical follow-up
 * ("Hva er kontraktsverdien?") must be answerable from that — guided by, and
 * verified against, structured data when possible.
 *
 * This module scans the recent turns (user and assistant) for those facts. It is
 * pure and dependency-free; history is used transiently and never stored/logged.
 */

import type { Metric } from "@/lib/chat/metricResolver";
import {
  METRIC_DEFS,
  parseNorwegianNumber,
  resolveMetric,
} from "@/lib/chat/metricResolver";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Metric values that were established for ONE specific project in history. */
export interface ProjectMetricFacts {
  /** The project these metrics belong to (number takes priority for matching). */
  projectNumber: string | null;
  projectName: string | null;
  metrics: Partial<Record<Metric, number>>;
}

export interface HistoryFacts {
  /** Most recently mentioned project name, if any. */
  projectName: string | null;
  /** Most recently mentioned project number, if any. */
  projectNumber: string | null;
  /**
   * Metric values established earlier, grouped by the project they belong to.
   * A value extracted from a section is attached ONLY to the project identified
   * in that same section — never applied across projects.
   */
  byProject: ProjectMetricFacts[];
}

const PROJECT_NUMBER_LABELLED =
  /\bprosjekt(?:nummer|nr)?\.?\s*[:=]?\s*(\d{3,6})\b/i;
const PROJECT_NUMBER_INLINE = /\bprosjekt\w*\s+(\d{3,6})\b/i;
// A standalone number, NOT part of a decimal/grouped number (e.g. "29.000").
const ANY_NUMBER = /(?<![\d.,%])\b(\d{3,6})\b(?![\d.,%])/;
// A four-digit year (2000–2099) is a time reference, never a project number.
const YEAR_RE = /^20\d{2}$/;

const PROJECT_NAME_LABELLED =
  /\bprosjekt(?:navn|tittel)\.?\s*[:=]\s*["«]?([^\n,;«»"]+?)["»]?\s*(?:[\n,;]|$)/i;
// "prosjekt 7100 = Pilestredet" / "= Pilestredet"
const PROJECT_NAME_EQUALS = /=\s*([A-ZÆØÅ][\wæøåÆØÅ-]+(?:\s+[A-ZÆØÅ][\wæøåÆØÅ-]+)?)/;

function extractProjectNumber(text: string): string | null {
  const labelled =
    text.match(PROJECT_NUMBER_LABELLED)?.[1] ??
    text.match(PROJECT_NUMBER_INLINE)?.[1];
  if (labelled) return labelled;
  const bare = text.match(ANY_NUMBER)?.[1];
  if (bare && !YEAR_RE.test(bare)) return bare;
  return null;
}

function extractProjectName(text: string): string | null {
  const labelled = text.match(PROJECT_NAME_LABELLED)?.[1]?.trim();
  if (labelled) return labelled;
  const equals = text.match(PROJECT_NAME_EQUALS)?.[1]?.trim();
  if (equals) return equals;
  return null;
}

/**
 * Strip project-number references from a value string BEFORE parsing the number,
 * so a sentence like "Kontraktsverdi for Pilestredet (prosjekt 7100) er
 * 150 705 668 kr" yields 150 705 668 — NOT 7100. Without this, the first number
 * on the line (the project number) is wrongly read as the metric value.
 */
function stripProjectRefs(text: string): string {
  return text
    .replace(/\(\s*prosjekt[^)]*\)/gi, " ")
    .replace(/\bprosjekt(?:nummer|nr)?\.?\s*[:=]?\s*\d{3,6}\b/gi, " ");
}

/**
 * Read a metric value from a single line of the form "<label>: <number>" or
 * "<label> = <number>", or a free sentence "<label> … er <number>". Splits on
 * the first separator so the number is read from the value side, resolves the
 * label to a canonical metric, and never treats a project number as the value.
 */
function metricFromLine(line: string): { metric: Metric; value: number } | null {
  const sepMatch = line.match(/^(.{1,60}?)\s*[:=]\s*(.+)$/);
  const labelPart = sepMatch ? sepMatch[1] : line;
  const valuePart = sepMatch ? sepMatch[2] : line;
  const match = resolveMetric(labelPart);
  if (!match) return null;
  // Remove any "prosjekt <nr>" tokens so the project number is never mistaken
  // for the metric value, then read the first remaining number.
  const value = parseNorwegianNumber(stripProjectRefs(valuePart));
  if (value === null) return null;
  return { metric: match.metric, value };
}

/** Metrics whose values are currency/hours and safe to parse as numbers. */
const NUMERIC_METRICS = new Set<Metric>(
  METRIC_DEFS.filter((d) => d.unit === "currency" || d.unit === "hours").map(
    (d) => d.metric,
  ),
);

/** Find or create the per-project group a metric should attach to. */
function groupFor(
  groups: ProjectMetricFacts[],
  projectNumber: string | null,
  projectName: string | null,
): ProjectMetricFacts {
  // Prefer matching on number; fall back to a case-insensitive name match.
  const existing = groups.find(
    (g) =>
      (projectNumber && g.projectNumber === projectNumber) ||
      (projectName &&
        g.projectName &&
        g.projectName.toLowerCase() === projectName.toLowerCase()),
  );
  if (existing) {
    // Backfill identity if this turn supplied a missing half.
    if (projectNumber && !existing.projectNumber) existing.projectNumber = projectNumber;
    if (projectName && !existing.projectName) existing.projectName = projectName;
    return existing;
  }
  const created: ProjectMetricFacts = { projectNumber, projectName, metrics: {} };
  groups.push(created);
  return created;
}

/**
 * Scan recent history for established project + metric facts. The most recent
 * turn wins for the top-level project identity; metric values are grouped by the
 * project identified in the SAME turn/section, so a value from one project is
 * never silently applied to another (cross-project leakage).
 */
export function extractHistoryFacts(history: HistoryMessage[]): HistoryFacts {
  const byProject: ProjectMetricFacts[] = [];
  let topName: string | null = null;
  let topNumber: string | null = null;
  // The most recently identified project, so a metric stated in a turn that
  // omits the identity (a continuation) attaches to the right project.
  let activeNumber: string | null = null;
  let activeName: string | null = null;

  // Walk oldest → newest so the newest project identity / value wins.
  for (const msg of history) {
    const number = extractProjectNumber(msg.content);
    const name = extractProjectName(msg.content);
    if (number) {
      topNumber = number;
      activeNumber = number;
      // A new project number resets the active name unless this turn renames it.
      activeName = name ?? null;
    }
    if (name) {
      topName = name;
      activeName = name;
    }

    for (const line of msg.content.split(/\n|(?:\s•\s)|(?:\s-\s)/)) {
      const found = metricFromLine(line);
      if (!found || !NUMERIC_METRICS.has(found.metric)) continue;
      // Never record a value that equals the project number on the same line —
      // that is the project identifier, not a currency amount.
      if (
        (activeNumber && found.value === Number(activeNumber)) ||
        (number && found.value === Number(number))
      ) {
        continue;
      }
      const group = groupFor(byProject, activeNumber, activeName);
      group.metrics[found.metric] = found.value;
    }
  }

  return { projectName: topName, projectNumber: topNumber, byProject };
}

/**
 * Look up a metric value established in history for a SPECIFIC resolved project.
 * Returns the value only when the history group's project matches the resolved
 * project by number (preferred) or name — never a value from a different
 * project. This is what stops "kontraktsverdien på AFBO NORA" from borrowing
 * Pilestredet's contract value.
 */
export function metricForResolvedProject(
  facts: HistoryFacts,
  resolved: { projectNumber: string | null; projectName: string | null },
  metric: Metric,
): number | undefined {
  const { projectNumber, projectName } = resolved;
  for (const group of facts.byProject) {
    const numberMatches = Boolean(
      projectNumber && group.projectNumber === projectNumber,
    );
    const nameMatches = Boolean(
      projectName &&
        group.projectName &&
        group.projectName.toLowerCase() === projectName.toLowerCase(),
    );
    // If we know the number for both and they disagree, this is NOT a match,
    // even if names happen to coincide.
    if (
      projectNumber &&
      group.projectNumber &&
      group.projectNumber !== projectNumber
    ) {
      continue;
    }
    if (numberMatches || nameMatches) {
      const value = group.metrics[metric];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}
