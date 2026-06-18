/**
 * Project tools — getProjectMetric / getProjectSummary / getProjectList.
 *
 * They read facts off the project record the runner resolved (Endre or
 * Firebase), never fetching themselves, so they stay pure and testable. The
 * important behaviour here is HONESTY about the contract value (plan point 7):
 * "kontraktsverdi" is only reported when the record actually carries a
 * contract-value field. Otherwise the tool returns coverage "partial" and points
 * at the amount fields it does have — it never passes off a generic total.
 */

import {
  metricDef,
  readMetricField,
  type Metric,
} from "@/lib/chat/metricResolver";
import type {
  Project,
  ProjectMetricValue,
  ProjectRef,
} from "@/lib/assistant/domain/project";
import { toProject } from "@/lib/assistant/ingestion/entities";
import {
  ok,
  none,
  partial,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@/lib/assistant/tools/registry";

function refOf(ctx: ToolContext): ProjectRef {
  return ctx.projectRef ?? { projectNumber: null, projectName: null };
}

/** Amount-aggregate keys an Endre summary may carry (set by endreSource). */
const AMOUNT_KEYS = ["amounts", "contracts", "cases"] as const;

/** Which amount aggregates are present on the record, for an honest fallback. */
function availableAmountFields(record: Record<string, unknown>): string[] {
  return AMOUNT_KEYS.filter((k) => record[k] !== undefined && record[k] !== null);
}

export interface GetProjectMetricInput {
  metric: Metric;
}

export const getProjectMetric: Tool<GetProjectMetricInput, ProjectMetricValue> = {
  name: "getProjectMetric",
  description:
    "Én konkret nøkkeltallverdi for et prosjekt (kontraktsverdi, resultat, " +
    "fakturert, datoer osv.). Rapporterer kun verdien hvis datakilden faktisk " +
    "har feltet — ellers sier den ærlig at feltet mangler.",
  validate: (raw) => {
    const input = raw as Partial<GetProjectMetricInput> | null;
    if (!input || typeof input.metric !== "string") {
      return { ok: false, error: "metric is required" };
    }
    return { ok: true, input: { metric: input.metric as Metric } };
  },
  async run(input, ctx): Promise<ToolResult<ProjectMetricValue>> {
    const record = ctx.projectRecord;
    const ref = refOf(ctx);
    const unit = metricDef(input.metric).unit;
    if (!record) {
      return none(
        "Fant ikke prosjektet i tilgjengelige datakilder.",
        ctx.projectSources ?? [],
      );
    }
    const value = readMetricField(record, input.metric);
    if (value !== null) {
      return ok({ metric: input.metric, unit, value, ref }, ctx.projectSources ?? []);
    }
    // No dedicated field. For contract value, be explicit and point at amounts.
    if (input.metric === "contract_value") {
      const amounts = availableAmountFields(record);
      return partial(
        { metric: input.metric, unit, value: null, ref },
        ctx.projectSources ?? [],
        amounts.length > 0
          ? `Fant prosjektet, men ikke et eget kontraktsverdi-felt. Tilgjengelige beløpsfelt: ${amounts.join(", ")}.`
          : "Fant prosjektet, men ikke et eget kontraktsverdi-felt.",
      );
    }
    return partial(
      { metric: input.metric, unit, value: null, ref },
      ctx.projectSources ?? [],
      `Fant prosjektet, men ikke et felt for ${input.metric}.`,
    );
  },
};

export const getProjectSummary: Tool<Record<string, never>, Record<string, unknown>> = {
  name: "getProjectSummary",
  description:
    "Oppsummering av ett prosjekt (alle tilgjengelige felt fra datakilden).",
  validate: () => ({ ok: true, input: {} }),
  async run(_input, ctx): Promise<ToolResult<Record<string, unknown>>> {
    if (!ctx.projectRecord) {
      return none("Fant ikke prosjektet.", ctx.projectSources ?? []);
    }
    return ok(ctx.projectRecord, ctx.projectSources ?? []);
  },
};

export interface CompareProjectsInput {
  /** Pre-gathered project records, each with the source it came from. */
  projects: { record: Record<string, unknown>; source: "endre" | "firebase" }[];
  /** Referenced project numbers that could not be found anywhere. */
  missing?: string[];
}

export const compareProjects: Tool<CompareProjectsInput, Project[]> = {
  name: "compareProjects",
  description:
    "Sammenlign flere prosjekter side om side. Hvert prosjekt beholder sin egen " +
    "kilde og felter — Endre-beløp blandes aldri med lokale nøkkeltall.",
  validate: (raw) => {
    const input = raw as Partial<CompareProjectsInput> | null;
    if (!input || !Array.isArray(input.projects)) {
      return { ok: false, error: "projects[] is required" };
    }
    return {
      ok: true,
      input: {
        projects: input.projects,
        missing: Array.isArray(input.missing) ? input.missing : [],
      },
    };
  },
  async run(input): Promise<ToolResult<Project[]>> {
    const projects = input.projects.map((p) => toProject(p.record, p.source));
    if (projects.length === 0) {
      return none("Fant ingen av de etterspurte prosjektene.");
    }
    const missing = input.missing ?? [];
    if (missing.length > 0) {
      return partial(
        projects,
        [],
        `Fant ${projects.length} prosjekt(er); fant ikke: ${missing.join(", ")}.`,
      );
    }
    return ok(projects, []);
  },
};

export const getProjectList: Tool<
  Record<string, never>,
  import("@/lib/chat/endreSource").ListedProject[]
> = {
  name: "getProjectList",
  description: "Liste over alle prosjekter (Endre + lokale, deduplisert).",
  validate: () => ({ ok: true, input: {} }),
  async run(_input, ctx) {
    const list = ctx.projectList ?? [];
    if (list.length === 0) return none("Ingen prosjekter tilgjengelig.");
    return ok(list, ctx.projectSources ?? ["projects"]);
  },
};
