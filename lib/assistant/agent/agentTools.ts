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

/** Request-scoped I/O the agent reads from (injected for testability). */
export interface AgentDeps {
  getStructuredTables: () => Promise<StoredStructuredTable[]>;
  getProjects: () => Promise<FirestoreDoc[]>;
  getAccounts: () => Promise<FirestoreDoc[]>;
  listDocuments: () => Promise<{ name: string; fileType: string }[]>;
  searchDocuments: (query: string) => Promise<DocumentMatch[]>;
  endreClient: EndreClient | null;
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
      "Rådata fra bemanningsplanens ark (f.eks. «Kapasitetsanalyse», " +
      "«Månedsbehov», «Rotasjonsplan»): kolonneoverskrifter + rader. Les og regn " +
      "selv. Store ark er avkortet — rowCount viser totalen.",
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
    name: "search_documents",
    description:
      "Søk i opplastede dokumenter (fritekst i PDF/Word/Excel). Bruk for " +
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
