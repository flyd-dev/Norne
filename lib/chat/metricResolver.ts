/**
 * Metric resolution: map a Norwegian (or English) label, synonym or typo to a
 * canonical project metric, plus the candidate field names that hold its value.
 *
 * Field crews and uploaded spreadsheets phrase the same number many ways
 * ("kontraktsverdi", "kontraktssum", "avtalesum") and frequently mistype it
 * ("kongraksverdi"). Centralising the mapping here means the planner, the
 * deterministic answer path and history-fact extraction all recognise the same
 * concept — so a synonym or typo fixed here is fixed everywhere.
 *
 * Pure and dependency-free for easy testing.
 */

export type Metric =
  | "contract_value"
  | "expected_result"
  | "result"
  | "invoiced_amount"
  | "total_costs"
  | "material_costs"
  | "other_costs"
  | "expected_income"
  | "start_date"
  | "end_date"
  | "estimated_hours"
  | "cmr"
  | "backlog";

/** How a metric value should be rendered when answering deterministically. */
export type MetricUnit = "currency" | "hours" | "date" | "plain";

export interface MetricDef {
  metric: Metric;
  /** Lowercased labels/synonyms (incl. common typos handled fuzzily). */
  labels: string[];
  /** Candidate field names in Firestore/Endre docs (matched fuzzily by key). */
  fields: string[];
  unit: MetricUnit;
}

/**
 * Definitions, ordered most-specific first. The first label that matches wins,
 * so multi-word/specific concepts (material_costs, expected_result) must precede
 * the generic ones they contain (total_costs "kostnader", result "resultat").
 */
export const METRIC_DEFS: MetricDef[] = [
  {
    metric: "contract_value",
    labels: [
      "kontraktsverdi",
      "kontraktssum",
      "kontrakssum",
      "avtalesum",
      "contract value",
      "contractvalue",
      "contract sum",
    ],
    fields: [
      "contract_value",
      "kontraktsverdi",
      "kontraktssum",
      "contractvalue",
      "avtalesum",
      "contract_sum",
    ],
    unit: "currency",
  },
  {
    metric: "material_costs",
    labels: ["materialkostnader", "materialkostnad", "material costs"],
    fields: ["material_costs", "materialkostnader", "materialcost"],
    unit: "currency",
  },
  {
    metric: "other_costs",
    labels: ["andre kostnader", "other costs", "øvrige kostnader"],
    fields: ["other_costs", "andre_kostnader", "othercosts"],
    unit: "currency",
  },
  {
    metric: "expected_result",
    labels: ["forventet resultat", "forventa resultat", "expected result"],
    fields: ["expected_result", "forventet_resultat", "expectedresult"],
    unit: "currency",
  },
  {
    metric: "expected_income",
    labels: [
      "forventet inntekt",
      "forventet omsetning",
      "expected income",
      "expected revenue",
    ],
    fields: ["expected_income", "forventet_inntekt", "expectedincome"],
    unit: "currency",
  },
  {
    metric: "invoiced_amount",
    labels: [
      "fakturerte beløp",
      "fakturert beløp",
      "fakturert",
      "fakturerte",
      "invoiced amount",
      "invoiced",
    ],
    fields: ["invoiced_amount", "fakturert", "fakturert_belop", "invoiced"],
    unit: "currency",
  },
  {
    metric: "total_costs",
    labels: [
      "totale kostnader",
      "totalkostnad",
      "totalkostnader",
      "total costs",
      "kostnader",
      "kostnad",
    ],
    fields: ["total_costs", "totale_kostnader", "kostnader", "totalkostnad"],
    unit: "currency",
  },
  {
    metric: "backlog",
    labels: ["ordrebeholdning", "ordrereserve", "backlog", "order reserve"],
    fields: ["backlog", "ordrebeholdning", "order_reserve", "ordrereserve"],
    unit: "currency",
  },
  {
    metric: "cmr",
    labels: ["cmr"],
    fields: ["cmr"],
    unit: "plain",
  },
  {
    metric: "start_date",
    labels: ["startdato", "oppstartsdato", "oppstart", "start date"],
    fields: ["start_date", "startdato", "startdate"],
    unit: "date",
  },
  {
    metric: "end_date",
    labels: ["sluttdato", "ferdigdato", "end date"],
    fields: ["end_date", "sluttdato", "enddate"],
    unit: "date",
  },
  {
    metric: "estimated_hours",
    labels: [
      "estimerte timer",
      "arbeidstimer",
      "antall timer",
      "timer",
      "hours",
    ],
    fields: ["estimated_hours", "timer", "arbeidstimer", "hours"],
    unit: "hours",
  },
  {
    metric: "result",
    labels: ["resultat", "result"],
    fields: ["result", "resultat"],
    unit: "currency",
  },
];

const BY_METRIC = new Map<Metric, MetricDef>(
  METRIC_DEFS.map((d) => [d.metric, d]),
);

export function metricDef(metric: Metric): MetricDef {
  const def = BY_METRIC.get(metric);
  if (!def) throw new Error(`Unknown metric: ${metric}`);
  return def;
}

export interface MetricMatch {
  metric: Metric;
  /** The label that matched, for diagnostics. */
  matchedLabel: string;
  /** True when the match required typo-tolerant (fuzzy) comparison. */
  fuzzy: boolean;
}

/** Levenshtein edit distance (iterative, O(m·n)). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-zæøå0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length >= 2);
}

/** Fuzzy threshold for a label: tolerate ~25% edits, at least 2. */
function fuzzyThreshold(label: string): number {
  return Math.max(2, Math.floor(label.length * 0.25));
}

/**
 * Resolve a metric from free text. Tries exact substring matching first (cheap,
 * precise), then a typo-tolerant pass over single-word tokens for the
 * distinctive labels — so "kongraksverdi" still resolves to contract_value.
 * Returns the most-specific match (definition order), or null.
 */
export function resolveMetric(text: string): MetricMatch | null {
  const haystack = normalize(text);

  // 1. Exact substring pass (definition order = specificity order).
  for (const def of METRIC_DEFS) {
    for (const label of def.labels) {
      if (haystack.includes(label)) {
        return { metric: def.metric, matchedLabel: label, fuzzy: false };
      }
    }
  }

  // 2. Typo-tolerant pass on distinctive single-word labels.
  const tokens = tokenize(text);
  for (const def of METRIC_DEFS) {
    for (const label of def.labels) {
      if (label.includes(" ") || label.length < 6) continue; // single, distinctive
      const threshold = fuzzyThreshold(label);
      for (const token of tokens) {
        if (token.length < 5) continue;
        if (Math.abs(token.length - label.length) > 4) continue;
        if (levenshtein(token, label) <= threshold) {
          return { metric: def.metric, matchedLabel: label, fuzzy: true };
        }
      }
    }
  }

  return null;
}

/** Normalize a field name for case- and separator-insensitive comparison. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9æøå]/g, "");
}

/**
 * Parse a Norwegian-formatted number from text: space / non-breaking-space /
 * period thousands separators and an optional comma decimal. "150 705 668 kr" →
 * 150705668, "1.234,5" → 1234.5. Returns null when no number is present.
 */
export function parseNorwegianNumber(text: string): number | null {
  // Thousands separators: ASCII space, NBSP, narrow NBSP, thin space or period.
  const match = text.match(/-?\d[\d    .]*(?:,\d+)?/);
  if (!match) return null;
  const raw = match[0];
  const [intPart, decPart] = raw.split(",");
  const digits = intPart.replace(/[^\d-]/g, "");
  if (digits === "" || digits === "-") return null;
  const value = decPart
    ? Number.parseFloat(`${digits}.${decPart.replace(/\D/g, "")}`)
    : Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read a metric's value from a record (Firestore/Endre doc), matching candidate
 * field names case- and separator-insensitively. Returns the raw value (number
 * for numeric/currency/hours, string for dates), or null.
 */
export function readMetricField(
  record: Record<string, unknown>,
  metric: Metric,
): number | string | null {
  const def = metricDef(metric);
  const index = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    const norm = normalizeKey(key);
    if (!index.has(norm)) index.set(norm, value);
  }
  for (const field of def.fields) {
    const value = index.get(normalizeKey(field));
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      if (def.unit === "date") return value.trim();
      const num = parseNorwegianNumber(value);
      if (num !== null) return num;
      return value.trim();
    }
  }
  return null;
}
