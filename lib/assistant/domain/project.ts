/** Canonical project domain model for the tool layer. */

import type { Metric, MetricUnit } from "@/lib/chat/metricResolver";

export interface ProjectRef {
  projectNumber: string | null;
  projectName: string | null;
}

/**
 * A project normalized into one shape regardless of source (Endre or Firebase).
 * `fields` holds the sanitized scalar fields for metric reading; `source` names
 * where it came from.
 */
export interface Project {
  projectNumber: string | null;
  projectName: string | null;
  fields: Record<string, unknown>;
  source: "endre" | "firebase";
}

/** A resolved metric value for a project, with the unit needed to render it. */
export interface ProjectMetricValue {
  metric: Metric;
  unit: MetricUnit;
  /** The value, or null when the project has no field for this metric. */
  value: number | string | null;
  ref: ProjectRef;
}
