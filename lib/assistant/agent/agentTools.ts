/**
 * Generic data-access tools for the reasoning agent.
 *
 * The philosophy here is "attach the data, let the model reason" — like dropping
 * a file into ChatGPT/Claude. Instead of domain-specific tools with baked-in
 * rules, these expose the RAW data sources (projects, accounts, staffing sheets,
 * documents) and let gpt-5.5 read, understand and compute itself. The tools own
 * no domain logic beyond fetching + light shaping; the model does the reasoning.
 *
 * I/O is injected (AgentDeps) so the set is unit-testable. Large tables are
 * capped with an explicit note so a 3 900-row rotation grid can't blow the
 * context — the model is told how many rows it didn't see.
 */

import type { StoredStructuredTable } from "@/lib/documents/types";
import type { FirestoreDoc } from "@/lib/firestore/types";
import type { DocumentMatch } from "@/lib/rag/documentSearch";
import type { EndreClient } from "@/lib/endre/client";
import { toProject } from "@/lib/assistant/ingestion/entities";
import {
  buildEndreProjectContext,
  dedupeProjects,
  listEndreProjects,
} from "@/lib/chat/endreSource";
import type { AgentTool } from "@/lib/assistant/agent/loop";

/** A project resolved from either the live Endre API or local Firebase data. */
export type ResolvedProjectRecord = {
  record: Record<string, unknown>;
  source: "endre" | "firebase";
};

/** Request-scoped I/O the agent reads from (injected for testability). */
export interface AgentDeps {
  getStructuredTables: () => Promise<StoredStructuredTable[]>;
  getProjects: () => Promise<FirestoreDoc[]>;
  getAccounts: () => Promise<FirestoreDoc[]>;
  getBudgetLines: (projectId: string) => Promise<Record<string, unknown>[]>;
  getQuantities: (projectId: string) => Promise<Record<string, unknown>[]>;
  listDocuments: () => Promise<{ name: string; fileType: string }[]>;
  searchDocuments: (query: string) => Promise<DocumentMatch[]>;
  /** The pre-synthesised whole-case overview (Nornebygg/HEYAS), or null. */
  readCaseDossier: () => Promise<string | null>;
  endreClient: EndreClient | null;
  /**
   * Optional per-turn memo for `resolveProjectRecord`, keyed by the normalized
   * query. Set by the runtime (buildDeps) so several tools asking about the same
   * project in one turn don't each re-run the Endre fan-out. Absent in unit tests
   * (resolution just runs uncached).
   */
  _resolveCache?: Map<string, Promise<ResolvedProjectRecord | null>>;
}

const MAX_ROWS_PER_SHEET = 120;
const MAX_ACCOUNTS = 400;

/** Drop internal id-like fields before data reaches the model. */
function stripIds(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "id" || /(_id|_uid)$/i.test(k) || /[a-z]Id$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Find a project in local Firebase data only (no Endre call). */
async function resolveFirebaseProject(
  query: string,
  deps: AgentDeps,
): Promise<FirestoreDoc | null> {
  const projects = await deps.getProjects();
  const q = query.trim().toLowerCase();
  const doc = projects.find(
    (p) =>
      String(p.project_number ?? "").trim().toLowerCase() === q ||
      String(p.project_name ?? "").trim().toLowerCase() === q,
  );
  return doc ?? null;
}

/** Endre-first project resolution; falls back to local Firebase data. */
async function resolveProjectRecordUncached(
  query: string,
  deps: AgentDeps,
): Promise<ResolvedProjectRecord | null> {
  if (deps.endreClient) {
    const endre = await buildEndreProjectContext(query, deps.endreClient, undefined, {
      projectNumber: /^\d{3,6}$/.test(query.trim()) ? query.trim() : null,
    });
    const rec = endre?.context.endre_project as Record<string, unknown> | undefined;
    if (rec) return { record: rec, source: "endre" };
  }
  const doc = await resolveFirebaseProject(query, deps);
  return doc ? { record: doc, source: "firebase" } : null;
}

/**
 * Resolve a project once per turn. The Endre fan-out (get_project) is expensive,
 * and the same project is often looked up by more than one tool in a turn, so the
 * result is memoized in `deps._resolveCache` (the promise, so concurrent lookups
 * share one request). Uncached when no cache is supplied (unit tests).
 */
async function resolveProjectRecord(
  query: string,
  deps: AgentDeps,
): Promise<ResolvedProjectRecord | null> {
  const cache = deps._resolveCache;
  if (!cache) return resolveProjectRecordUncached(query, deps);
  const key = query.trim().toLowerCase();
  let pending = cache.get(key);
  if (!pending) {
    pending = resolveProjectRecordUncached(query, deps);
    cache.set(key, pending);
  }
  return pending;
}

export const AGENT_TOOLS: AgentTool<AgentDeps>[] = [
  {
    name: "list_sources",
    description:
      "Oversikt over hvilke data som finnes: prosjekter, kontoplan, " +
      "bemanningsplan-ark og opplastede dokumenter. Kall denne først hvis du er " +
      "usikker på hva som er tilgjengelig.",
    parameters: { type: "object", properties: {} },
    async execute(_args, deps) {
      const [tables, projects, accounts, docs] = await Promise.all([
        deps.getStructuredTables(),
        deps.getProjects(),
        deps.getAccounts(),
        deps.listDocuments(),
      ]);
      const endre = deps.endreClient ? (await listEndreProjects(deps.endreClient)) ?? [] : [];
      const projectList = dedupeProjects([
        ...endre,
        ...projects.map((p) => ({
          projectNumber: p.project_number != null ? String(p.project_number) : null,
          projectName: typeof p.project_name === "string" ? p.project_name : null,
        })),
      ]);
      return {
        projects: projectList,
        accountsCount: accounts.length,
        documents: docs,
        staffingSheets: tables.map((t) => ({
          document: t.documentName,
          sheet: t.sheetName,
          columns: t.columns,
          rowCount: t.rows.length,
        })),
      };
    },
  },
  {
    name: "get_projects",
    description:
      "Alle prosjekter med feltene som finnes. Lokale prosjekter har fulle " +
      "nøkkeltall; Endre-prosjekter har bare navn/nummer her (bruk get_project " +
      "for Endre-beløp). Les og resonner selv — f.eks. for sammenligning eller " +
      "«høyest X».",
    parameters: { type: "object", properties: {} },
    async execute(_args, deps) {
      const local = (await deps.getProjects()).map((p) => ({
        source: "firebase" as const,
        ...stripIds(p),
      }));
      const endre = deps.endreClient ? (await listEndreProjects(deps.endreClient)) ?? [] : [];
      const endreList = endre.map((p) => ({
        source: "endre" as const,
        project_number: p.projectNumber,
        project_name: p.projectName,
      }));
      const sources = ["projects", ...(endreList.length > 0 ? ["Endre API: projects"] : [])];
      return { projects: [...local, ...endreList], sources };
    },
  },
  {
    name: "get_project",
    description:
      "Alle felt for ett prosjekt (nummer eller navn), fra Endre (live, inkl. " +
      "beløpsposter) eller lokal prosjektdata. Les nøkkeltall herfra.",
    parameters: {
      type: "object",
      properties: { project: { type: "string", description: "Prosjektnummer eller -navn." } },
      required: ["project"],
    },
    async execute(args, deps) {
      const found = await resolveProjectRecord(String(args.project ?? ""), deps);
      if (!found) return { found: false };
      const p = toProject(found.record, found.source);
      return {
        found: true,
        source: p.source,
        projectNumber: p.projectNumber,
        projectName: p.projectName,
        fields: stripIds(p.fields),
        sources: [found.source === "endre" ? "Endre API: projects" : "projects"],
      };
    },
  },
  {
    name: "get_accounts",
    description: "Hele kontoplanen (kontonummer + navn + felt). Velg riktig konto selv.",
    parameters: { type: "object", properties: {} },
    async execute(_args, deps) {
      const accounts = await deps.getAccounts();
      return {
        count: accounts.length,
        truncated: accounts.length > MAX_ACCOUNTS,
        accounts: accounts.slice(0, MAX_ACCOUNTS).map(stripIds),
        sources: ["accounts"],
      };
    },
  },
  {
    name: "read_staffing_sheets",
    description:
      "FORETRUKKET kilde for alle bemannings- og kapasitetsspørsmål: rådata fra " +
      "bemanningsplanens ark (f.eks. «Kapasitetsanalyse», «Månedsbehov», " +
      "«Rotasjonsplan») med kolonneoverskrifter + hele rader, så du kan regne " +
      "selv. Bruk denne — ikke search_documents — for tall om kapasitet, timer " +
      "og bemanning. Store ark er avkortet — rowCount viser totalen.",
    parameters: {
      type: "object",
      properties: { sheet: { type: "string", description: "Begrens til ett ark (delvis navn)." } },
    },
    async execute(args, deps) {
      let tables = await deps.getStructuredTables();
      const needle = typeof args.sheet === "string" ? args.sheet.toLowerCase() : null;
      if (needle) tables = tables.filter((t) => (t.sheetName ?? "").toLowerCase().includes(needle));
      return {
        sources: [...new Set(tables.map((t) => t.documentName))],
        sheets: tables.map((t) => ({
          document: t.documentName,
          sheet: t.sheetName,
          columns: t.columns,
          rowCount: t.rows.length,
          truncated: t.rows.length > MAX_ROWS_PER_SHEET,
          rows: t.rows.slice(0, MAX_ROWS_PER_SHEET),
        })),
      };
    },
  },
  {
    name: "get_budget_lines",
    description:
      "Budsjettlinjer for et lokalt prosjekt (Firebase). Finnes bare for lokale " +
      "prosjekter, ikke Endre-prosjekter.",
    parameters: {
      type: "object",
      properties: { project: { type: "string", description: "Prosjektnummer eller -navn." } },
      required: ["project"],
    },
    async execute(args, deps) {
      // Budget lines only exist for local (Firebase) projects, so resolve against
      // Firebase directly — never trigger the Endre fan-out just to discard it.
      const record = await resolveFirebaseProject(String(args.project ?? ""), deps);
      if (!record) {
        return { found: false, note: "Budsjettlinjer finnes bare for lokale prosjekter." };
      }
      const id = String(record.id ?? "");
      if (!id) return { found: false };
      const rows = await deps.getBudgetLines(id);
      return {
        found: true,
        count: rows.length,
        truncated: rows.length > 200,
        rows: rows.slice(0, 200).map(stripIds),
        sources: ["budgetLines"],
      };
    },
  },
  {
    name: "get_quantities",
    description:
      "Mengder for et lokalt prosjekt (Firebase). Finnes bare for lokale prosjekter.",
    parameters: {
      type: "object",
      properties: { project: { type: "string", description: "Prosjektnummer eller -navn." } },
      required: ["project"],
    },
    async execute(args, deps) {
      // Quantities only exist for local (Firebase) projects — resolve directly.
      const record = await resolveFirebaseProject(String(args.project ?? ""), deps);
      if (!record) {
        return { found: false, note: "Mengder finnes bare for lokale prosjekter." };
      }
      const id = String(record.id ?? "");
      if (!id) return { found: false };
      const rows = await deps.getQuantities(id);
      return {
        found: true,
        count: rows.length,
        truncated: rows.length > 200,
        rows: rows.slice(0, 200).map(stripIds),
        sources: ["quantities"],
      };
    },
  },
  {
    name: "get_case_dossier",
    description:
      "Det ferdig analyserte saksdossieret for Nornebygg/HEYAS-saken: sakens " +
      "kjerne, parter, tidslinje, omtvistede punkter, styrker OG svakheter, og " +
      "status. Kall dette FØRST på alle spørsmål om saken, rettssaken, " +
      "prosessen, prosessrisiko, sannsynlighet for ulike utfall, eller en " +
      "vurdering av hvordan saken står. Bygg videre med search_documents for " +
      "konkrete sitater/detaljer.",
    parameters: { type: "object", properties: {} },
    async execute(_args, deps) {
      const text = await deps.readCaseDossier();
      if (!text) {
        return {
          found: false,
          note: "Saksdossieret er ikke generert ennå. Bruk search_documents på sakens dokumenter i stedet.",
        };
      }
      return { found: true, dossier: text, sources: ["Saksdossier (Nornebygg/HEYAS)"] };
    },
  },
  {
    name: "search_documents",
    description:
      "Søk i fritekst i opplastede dokumenter (PDF/Word, og fritekstceller i " +
      "Excel). Gir bare avkortede, rangerte tekstutdrag — for tallmessig " +
      "bemanning/kapasitet bruk read_staffing_sheets i stedet. Bruk denne for " +
      "dokumentinnhold som ikke er strukturerte tabeller.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        document: { type: "string", description: "Begrens til ett dokument (delvis navn)." },
      },
      required: ["query"],
    },
    async execute(args, deps) {
      let matches = await deps.searchDocuments(String(args.query ?? ""));
      if (typeof args.document === "string") {
        const needle = args.document.toLowerCase();
        matches = matches.filter((m) => m.documentName.toLowerCase().includes(needle));
      }
      return {
        sources: [...new Set(matches.map((m) => m.documentName))],
        hits: matches.map((m) => ({
          document: m.documentName,
          sheet: m.sheetName ?? null,
          text: m.text,
        })),
      };
    },
  },
];
