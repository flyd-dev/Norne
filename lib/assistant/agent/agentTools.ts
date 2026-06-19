/**
 * Agent-facing tools: natural JSON-schema interfaces the model calls, each
 * self-contained (does its own I/O via injected deps) but delegating the actual
 * computation to the deterministic pure tools — so the agent orchestrates while
 * the tools still own the validated facts (coverage, contract-value honesty,
 * persons→hours estimate). I/O is injected so the set is unit-testable.
 */

import type { StoredStructuredTable } from "@/lib/documents/types";
import type { FirestoreDoc } from "@/lib/firestore/types";
import type { DocumentMatch } from "@/lib/rag/documentSearch";
import type { EndreClient } from "@/lib/endre/client";
import type { CanonicalRole } from "@/lib/chat/roles";
import {
  parseAnyMonth,
  type MonthBound,
} from "@/lib/chat/dateRange";
import {
  readStructuredAvailability,
  availableHoursForMonth,
  HOURS_PER_PERSON_MONTH,
} from "@/lib/chat/capacityStructured";
import { capacityRowsFromTables } from "@/lib/assistant/ingestion/capacity";
import { getMonthlyCapacity } from "@/lib/assistant/tools/capacity";
import { compareProjects } from "@/lib/assistant/tools/projects";
import { getAccountForPurchase } from "@/lib/assistant/tools/accounts";
import { searchUploadedDocuments } from "@/lib/assistant/tools/documents";
import { toProject } from "@/lib/assistant/ingestion/entities";
import { buildEndreProjectContext, dedupeProjects, listEndreProjects } from "@/lib/chat/endreSource";
import type { AgentTool } from "@/lib/assistant/agent/loop";

/** Request-scoped I/O the agent tools depend on (injected for testability). */
export interface AgentDeps {
  getStructuredTables: () => Promise<StoredStructuredTable[]>;
  getProjects: () => Promise<FirestoreDoc[]>;
  getAccounts: () => Promise<FirestoreDoc[]>;
  searchDocuments: (query: string) => Promise<DocumentMatch[]>;
  endreClient: EndreClient | null;
}

const ROLE_ENUM = ["Steel fixer", "Carpenter", "Welder"];

function asRole(v: unknown): CanonicalRole | null {
  return v === "Steel fixer" || v === "Carpenter" || v === "Welder" ? v : null;
}

/** Resolve one project (number or name) to a record + source: Endre first, else Firestore. */
async function resolveProjectRecord(
  query: string,
  deps: AgentDeps,
): Promise<{ record: Record<string, unknown>; source: "endre" | "firebase" } | null> {
  if (deps.endreClient) {
    const endre = await buildEndreProjectContext(query, deps.endreClient, undefined, {
      projectNumber: /^\d{3,6}$/.test(query.trim()) ? query.trim() : null,
    });
    const rec = endre?.context.endre_project as Record<string, unknown> | undefined;
    if (rec) return { record: rec, source: "endre" };
  }
  const projects = await deps.getProjects();
  const q = query.trim().toLowerCase();
  const doc = projects.find(
    (p) =>
      String(p.project_number ?? "").trim().toLowerCase() === q ||
      String(p.project_name ?? "").trim().toLowerCase() === q,
  );
  return doc ? { record: doc, source: "firebase" } : null;
}

export const AGENT_TOOLS: AgentTool<AgentDeps>[] = [
  {
    name: "get_monthly_capacity",
    description:
      "Tilgjengelig kapasitet per fag per måned fra bemanningsplanen. Bruk for " +
      "spørsmål om kapasitet per måned eller en periode. Tall er personer per måned.",
    parameters: {
      type: "object",
      properties: {
        until_month: { type: "string", description: "ISO «YYYY-MM» eller månedsnavn — opp til og med." },
        from_month: { type: "string", description: "ISO «YYYY-MM» eller månedsnavn — fra og med." },
        role: { type: "string", enum: ROLE_ENUM },
      },
    },
    async execute(args, deps) {
      let bound: MonthBound | undefined;
      const until = parseAnyMonth(String(args.until_month ?? ""));
      const from = parseAnyMonth(String(args.from_month ?? ""));
      if (until) bound = { kind: "upTo", month: until.month, year: until.year };
      else if (from) bound = { kind: "from", month: from.month, year: from.year };
      const tables = await deps.getStructuredTables();
      return getMonthlyCapacity.run(
        { bound, role: asRole(args.role) },
        {
          getCapacityRows: async () => capacityRowsFromTables(tables),
          documentMatches: await deps.searchDocuments("kapasitet bemanningsplan kapasitetsanalyse"),
        },
      );
    },
  },
  {
    name: "get_available_hours_for_month",
    description:
      "Tilgjengelig kapasitet i TIMER for én måned, estimert som personer × " +
      `${HOURS_PER_PERSON_MONTH} t/person/mnd (48 t/uke). Bruk når et behov er i ` +
      "timer og du skal sammenligne. Resultatet er et estimat.",
    parameters: {
      type: "object",
      properties: {
        month: { type: "string", description: "ISO «YYYY-MM» eller månedsnavn." },
        role: { type: "string", enum: ROLE_ENUM },
      },
      required: ["month"],
    },
    async execute(args, deps) {
      const tables = await deps.getStructuredTables();
      const avail = readStructuredAvailability(tables);
      const forMonth = availableHoursForMonth(avail, String(args.month ?? ""));
      if (!forMonth) {
        return { found: false, note: "Ingen kapasitetsdata for den måneden." };
      }
      const role = asRole(args.role);
      const byRole = Object.fromEntries(
        [...forMonth.byRole.entries()].filter(([r]) => !role || r === role),
      );
      return {
        found: true,
        month: forMonth.monthLabel,
        unit: "timer",
        estimate: true,
        assumption: `personer × ${HOURS_PER_PERSON_MONTH} t/person/mnd`,
        source: "bemanningsplan / Kapasitetsanalyse",
        availableHours: byRole,
      };
    },
  },
  {
    name: "get_project",
    description:
      "Hent ett prosjekt (nummer eller navn) med sine felter, fra Endre (live) " +
      "eller lokal prosjektdata. Les nøkkeltall herfra; finn aldri på felter som " +
      "ikke finnes (f.eks. kontraktsverdi mangler ofte i Endre).",
    parameters: {
      type: "object",
      properties: { project: { type: "string", description: "Prosjektnummer eller -navn." } },
      required: ["project"],
    },
    async execute(args, deps) {
      const found = await resolveProjectRecord(String(args.project ?? ""), deps);
      if (!found) return { found: false };
      const p = toProject(found.record, found.source);
      return { found: true, projectNumber: p.projectNumber, projectName: p.projectName, source: p.source, fields: p.fields };
    },
  },
  {
    name: "compare_projects",
    description: "Sammenlign flere prosjekter side om side; hvert beholder sin egen kilde og felter.",
    parameters: {
      type: "object",
      properties: { projects: { type: "array", items: { type: "string" }, description: "Prosjektnumre/-navn." } },
      required: ["projects"],
    },
    async execute(args, deps) {
      const refs = Array.isArray(args.projects) ? args.projects.map(String) : [];
      const gathered: { record: Record<string, unknown>; source: "endre" | "firebase" }[] = [];
      const missing: string[] = [];
      for (const ref of refs) {
        const found = await resolveProjectRecord(ref, deps);
        if (found) gathered.push(found);
        else missing.push(ref);
      }
      return compareProjects.run({ projects: gathered, missing }, {});
    },
  },
  {
    name: "list_projects",
    description: "List alle prosjekter (Endre + lokale, deduplisert).",
    parameters: { type: "object", properties: {} },
    async execute(_args, deps) {
      const local = (await deps.getProjects()).map((d) => ({
        projectNumber: d.project_number != null ? String(d.project_number) : null,
        projectName: typeof d.project_name === "string" ? d.project_name : null,
      }));
      const endre = deps.endreClient ? (await listEndreProjects(deps.endreClient)) ?? [] : [];
      return { projects: dedupeProjects([...endre, ...local]) };
    },
  },
  {
    name: "search_chart_of_accounts",
    description: "Foreslå riktig konto for et innkjøp / søk i kontoplanen.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Hva som kjøpes, f.eks. «arbeidshansker»." } },
      required: ["query"],
    },
    async execute(args, deps) {
      const accounts = await deps.getAccounts();
      const r = await getAccountForPurchase.run({ query: String(args.query ?? "") }, { accounts });
      return {
        coverage: r.coverage,
        accounts: (r.data ?? []).map((a) => a.account),
        note: r.note,
      };
    },
  },
  {
    name: "search_documents",
    description: "Søk i opplastede dokumenter (fritekst i PDF/Word/Excel). Kun for dokumentinnhold.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        document: { type: "string", description: "Begrens til ett dokument (delvis navn)." },
      },
      required: ["query"],
    },
    async execute(args, deps) {
      const matches = await deps.searchDocuments(String(args.query ?? ""));
      return searchUploadedDocuments.run(
        { query: String(args.query ?? ""), ...(args.document ? { document: String(args.document) } : {}) },
        { documentMatches: matches },
      );
    },
  },
];
