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

export interface HistoryFacts {
  /** Most recently mentioned project name, if any. */
  projectName: string | null;
  /** Most recently mentioned project number, if any. */
  projectNumber: string | null;
  /** Metric values established earlier in the conversation. */
  metrics: Partial<Record<Metric, number>>;
}

const PROJECT_NUMBER_LABELLED =
  /\bprosjekt(?:nummer|nr)?\.?\s*[:=]?\s*(\d{3,6})\b/i;
const PROJECT_NUMBER_INLINE = /\bprosjekt\w*\s+(\d{3,6})\b/i;
// A standalone number, NOT part of a decimal/grouped number (e.g. "29.000").
const ANY_NUMBER = /(?<![\d.,%])\b(\d{3,6})\b(?![\d.,%])/;

const PROJECT_NAME_LABELLED =
  /\bprosjekt(?:navn|tittel)\.?\s*[:=]\s*["«]?([^\n,;«»"]+?)["»]?\s*(?:[\n,;]|$)/i;
// "prosjekt 7100 = Pilestredet" / "= Pilestredet"
const PROJECT_NAME_EQUALS = /=\s*([A-ZÆØÅ][\wæøåÆØÅ-]+(?:\s+[A-ZÆØÅ][\wæøåÆØÅ-]+)?)/;

function extractProjectNumber(text: string): string | null {
  return (
    text.match(PROJECT_NUMBER_LABELLED)?.[1] ??
    text.match(PROJECT_NUMBER_INLINE)?.[1] ??
    text.match(ANY_NUMBER)?.[1] ??
    null
  );
}

function extractProjectName(text: string): string | null {
  const labelled = text.match(PROJECT_NAME_LABELLED)?.[1]?.trim();
  if (labelled) return labelled;
  const equals = text.match(PROJECT_NAME_EQUALS)?.[1]?.trim();
  if (equals) return equals;
  return null;
}

/**
 * Read a metric value from a single line of the form "<label>: <number>" or
 * "<label> = <number>". Splits on the first separator so the number is read from
 * the value side, then resolves the label to a canonical metric.
 */
function metricFromLine(line: string): { metric: Metric; value: number } | null {
  const sepMatch = line.match(/^(.{1,60}?)\s*[:=]\s*(.+)$/);
  const labelPart = sepMatch ? sepMatch[1] : line;
  const valuePart = sepMatch ? sepMatch[2] : line;
  const match = resolveMetric(labelPart);
  if (!match) return null;
  const value = parseNorwegianNumber(valuePart);
  if (value === null) return null;
  return { metric: match.metric, value };
}

/** Metrics whose values are currency/hours and safe to parse as numbers. */
const NUMERIC_METRICS = new Set<Metric>(
  METRIC_DEFS.filter((d) => d.unit === "currency" || d.unit === "hours").map(
    (d) => d.metric,
  ),
);

/**
 * Scan recent history for established project + metric facts. The most recent
 * turn wins for project identity; metric values are collected across turns
 * (a later, more specific value overrides an earlier one).
 */
export function extractHistoryFacts(history: HistoryMessage[]): HistoryFacts {
  const facts: HistoryFacts = {
    projectName: null,
    projectNumber: null,
    metrics: {},
  };

  // Walk oldest → newest so the newest project identity / value wins.
  for (const msg of history) {
    const number = extractProjectNumber(msg.content);
    if (number) facts.projectNumber = number;
    const name = extractProjectName(msg.content);
    if (name) facts.projectName = name;

    for (const line of msg.content.split(/\n|(?:\s•\s)|(?:\s-\s)/)) {
      const found = metricFromLine(line);
      if (found && NUMERIC_METRICS.has(found.metric)) {
        facts.metrics[found.metric] = found.value;
      }
    }
  }

  return facts;
}
