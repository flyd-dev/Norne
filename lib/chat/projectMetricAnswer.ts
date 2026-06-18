/**
 * Deterministic answer path for direct project-metric questions.
 *
 * When the plan resolves a known project AND a known metric AND the value is
 * present in a structured source or recent history, we must NOT depend on the
 * LLM to re-infer it (that is exactly the failure mode this rework fixes: the
 * model saw the value a turn ago and still answered "jeg har ikke nok
 * informasjon"). Instead we format the answer directly, in natural Norwegian.
 *
 * Pure and dependency-free for easy testing.
 */

import { metricDef, type Metric } from "@/lib/chat/metricResolver";

/** Where a deterministic value was found. */
export type MetricValueSource = "structured" | "history";

export interface MetricAnswerInput {
  metric: Metric;
  value: number | string;
  projectName: string | null;
  projectNumber: string | null;
  /** The user's question, used to decide phrasing ("total kontraktsverdi"). */
  question: string;
}

/** Norwegian label per metric (lowercase noun phrase). */
const METRIC_LABELS: Record<Metric, string> = {
  contract_value: "kontraktsverdi",
  expected_result: "forventet resultat",
  result: "resultat",
  invoiced_amount: "fakturert beløp",
  total_costs: "totale kostnader",
  material_costs: "materialkostnader",
  other_costs: "andre kostnader",
  expected_income: "forventet inntekt",
  start_date: "startdato",
  end_date: "sluttdato",
  estimated_hours: "estimerte timer",
  cmr: "CMR",
  backlog: "ordrebeholdning",
};

/** Format an integer/amount with Norwegian thousands spacing: 150705668 → "150 705 668". */
export function formatNumberNo(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const [intPart, decPart] = String(rounded).split(".");
  const spaced = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return decPart ? `${spaced},${decPart}` : spaced;
}

function formatValue(metric: Metric, value: number | string): string {
  const def = metricDef(metric);
  if (typeof value === "string") return value;
  switch (def.unit) {
    case "currency":
      return `${formatNumberNo(value)} kr`;
    case "hours":
      return `${formatNumberNo(value)} timer`;
    default:
      return formatNumberNo(value);
  }
}

/** "Pilestredet (prosjekt 7100)" / "prosjekt 7100" / "Pilestredet". */
function projectReference(name: string | null, number: string | null): string {
  if (name && number) return `${name} (prosjekt ${number})`;
  if (name) return name;
  if (number) return `prosjekt ${number}`;
  return "prosjektet";
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Build the deterministic answer sentence, e.g.
 * "Total kontraktsverdi for Pilestredet (prosjekt 7100) er 150 705 668 kr."
 */
export function buildProjectMetricAnswer(input: MetricAnswerInput): string {
  const { metric, value, projectName, projectNumber, question } = input;
  let label = METRIC_LABELS[metric];
  // Honour an explicit "total" in the question for amount-style metrics.
  if (/\btotal[at]?\b/i.test(question) && metric === "contract_value") {
    label = `total ${label}`;
  }
  const ref = projectReference(projectName, projectNumber);
  const formatted = formatValue(metric, value);
  return `${capitalize(label)} for ${ref} er ${formatted}.`;
}
