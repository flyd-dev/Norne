/**
 * Optional live-data bridge between the chatbot and the Endre public REST API.
 *
 * This is the ONLY place that turns Endre responses into model context. It is
 * called from the orchestrator for project-related questions when, and only
 * when, the integration is ready (`ENDRE_API_ENABLED=true` + credentials — see
 * `getEndreClient()` / `endreReady()`). Firebase / uploaded documents remain the
 * fallback: every failure path here returns `null` so the caller keeps its
 * existing behaviour.
 *
 * Safety rules enforced here:
 *   - NEVER throw to the caller — any error returns `null` (graceful fallback).
 *   - NEVER expose raw API payloads, tokens, or credentials. Every value that
 *     reaches the model is run through `sanitizeRecord`, which keeps only short
 *     scalar fields and drops anything that looks like a secret.
 *   - NEVER log payloads, ids, tokens, or errors here.
 */

import "server-only";
import type { EndreClient } from "@/lib/endre/client";
import { resolveProject, type ProjectLike } from "@/lib/chat/projectResolver";
import { compactScalars } from "@/lib/firestore/normalize";
import type { FirestoreDoc } from "@/lib/firestore/types";

/** Max projects included when answering a project-list question. */
const MAX_PROJECTS_LISTED = 50;
/** Max example rows kept from an amounts/cases/contracts collection. */
const MAX_SAMPLE_ROWS = 5;
/** Max tag/organization names kept. */
const MAX_NAMES = 25;

/** Candidate fields that may hold a project's id, in priority order. */
const ID_FIELDS = ["id", "project_id", "projectId", "uuid", "guid"] as const;
/** Fields resolveProject matches on; coerced to strings so numeric values match. */
const NAME_FIELDS = [
  "project_name",
  "project_number",
  "name",
  "navn",
  "title",
  "projectName",
  "displayName",
] as const;
/** Field names whose values must never reach the model or logs. */
const SENSITIVE_KEY = /token|password|secret|authorization|api[_-]?key|credential/i;

export interface EndreProjectResult {
  /** Sanitized block(s) to merge into the model context. */
  context: Record<string, unknown>;
  /** Clearly-marked source labels, e.g. "Endre API: project_amounts". */
  sources: string[];
}

/**
 * Mutable diagnostics bag the caller may pass in to learn WHY Endre was or was
 * not used, without changing the return contract (a non-null result still means
 * "use Endre", null still means "fall back"). Contains only safe scalars — a
 * project-number token, booleans, and a coded fallback reason — never payloads,
 * ids, tokens, or free-text. See `logEndreDiagnostics`.
 */
export interface EndreDiagnostics {
  /** The project-number token we tried to match (e.g. "7100"), or null. */
  projectQuery: string | null;
  /** True once the Endre project list call was actually issued. */
  attemptedEndre: boolean;
  /** True when Endre produced a usable context block. */
  endreFound: boolean;
  /** Coded reason we fell back to Firebase (null when endreFound). */
  fallbackReason: string | null;
}

/** Result of the admin debug lookup — sanitized projects only, never raw. */
export interface EndreProjectDebugResult {
  /** Total projects returned by Endre (after coercion to an array). */
  total: number;
  /** How many matched the query. */
  count: number;
  /** Sanitized matching projects (short scalar fields only, no ids/secrets). */
  projects: Record<string, unknown>[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Coerce an Endre list response into an array. Endpoints may return a bare array
 * or a common envelope ({ data | items | results | projects: [...] }).
 */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  if (!rec) return [];
  for (const key of ["data", "items", "results", "projects", "value"]) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  return [];
}

/**
 * Keep only short scalar fields, drop nested structures (via compactScalars),
 * then strip anything whose key looks like a secret. Guarantees no raw payloads
 * or credentials reach the model.
 */
function sanitizeRecord(value: unknown): Record<string, unknown> {
  const rec = asRecord(value);
  if (!rec) return {};
  // compactScalars reads scalar fields and ignores "id"; the cast just satisfies
  // its FirestoreDoc parameter type (Endre records carry no required id here).
  const compact = compactScalars(rec as FirestoreDoc);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(compact)) {
    if (SENSITIVE_KEY.test(key)) continue;
    out[key] = val;
  }
  return out;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Aggregate a row collection (amounts / cases / contracts) into a compact
 * summary — count, per-field numeric totals, and a small sanitized sample — so
 * the model never sees the raw payload.
 */
function aggregateRows(value: unknown): {
  count: number;
  totals: Record<string, number>;
  sample: Record<string, unknown>[];
} {
  const rows = toArray(value);
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    for (const [key, val] of Object.entries(rec)) {
      if (SENSITIVE_KEY.test(key)) continue;
      if (typeof val === "number" && Number.isFinite(val)) {
        totals[key] = (totals[key] ?? 0) + val;
      }
    }
  }
  for (const key of Object.keys(totals)) totals[key] = roundMoney(totals[key]);
  const sample = rows.slice(0, MAX_SAMPLE_ROWS).map(sanitizeRecord);
  return { count: rows.length, totals, sample };
}

/** Pull a short list of human-readable names from a tags/organizations payload. */
function extractNames(value: unknown): { count: number; items: string[] } {
  const rows = toArray(value);
  const items: string[] = [];
  for (const row of rows) {
    if (typeof row === "string" && row.trim()) {
      items.push(row.trim());
      continue;
    }
    const rec = asRecord(row);
    if (!rec) continue;
    for (const field of ["name", "title", "label", "navn", "tag"]) {
      const v = rec[field];
      if (typeof v === "string" && v.trim()) {
        items.push(v.trim());
        break;
      }
    }
  }
  return { count: rows.length, items: items.slice(0, MAX_NAMES) };
}

/** Map an unknown Endre project object into a ProjectLike for resolveProject. */
function toProjectLike(value: unknown): ProjectLike | null {
  const rec = asRecord(value);
  if (!rec) return null;
  let id: string | undefined;
  for (const field of ID_FIELDS) {
    const v = rec[field];
    if (typeof v === "string" && v.trim()) {
      id = v.trim();
      break;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      id = String(v);
      break;
    }
  }
  if (!id) return null;

  const like: ProjectLike = { id, ...sanitizeRecord(rec) };
  // Ensure the fields resolveProject matches on are present as strings, even
  // when Endre returns the project number as a number.
  for (const field of NAME_FIELDS) {
    const v = rec[field];
    if (v !== undefined && v !== null && typeof v !== "object") {
      like[field] = String(v);
    }
  }
  return like;
}

/** Drop the internal id from a project record before it reaches the model. */
function withoutId(project: ProjectLike): Record<string, unknown> {
  const { id: _id, ...rest } = project;
  return rest;
}

/** Run a best-effort Endre call; a failing endpoint yields null, not a throw. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * True when the message points at one specific project (a project number or an
 * explicit document id). Used to decide whether a missing project should fall
 * back to Firebase (specific lookup) rather than answer with the project list.
 */
function referencesSpecificProject(message: string): boolean {
  return /\b\d{3,6}\b/.test(message) || /\b[A-Za-z0-9]{20}\b/.test(message);
}

/**
 * Extract the short project-number token a message refers to (e.g. "7100" from
 * "Oppsummer prosjekt 7100"), or null. Safe to log — it is a project number, not
 * free-text. Used both for matching and for diagnostics.
 */
function extractProjectQuery(message: string): string | null {
  const match = message.match(/\b\d{3,6}\b/);
  return match ? match[0] : null;
}

/**
 * Resolve a project by exact match of a number token against ANY scalar field,
 * regardless of that field's name. This makes the integration robust to Endre's
 * own field naming (project_number vs projectNo vs number vs …): resolveProject
 * only matches the fixed PROJECT_NAME_FIELDS, so a number under a differently
 * named field would otherwise be missed and wrongly fall back to Firebase.
 * Returns the single match, or null when there is no unique match.
 */
function matchByNumberToken(
  projects: ProjectLike[],
  token: string,
): ProjectLike | null {
  const hits = projects.filter((p) =>
    Object.entries(p).some(
      ([key, value]) =>
        key !== "id" &&
        (typeof value === "string" || typeof value === "number") &&
        String(value).trim() === token,
    ),
  );
  return hits.length === 1 ? hits[0] : null;
}

async function buildSingleProjectSummary(
  client: EndreClient,
  project: ProjectLike,
): Promise<EndreProjectResult> {
  const sources = ["Endre API: projects"];
  const summary: Record<string, unknown> = withoutId(project);

  // Fuller detail (best effort) — overlays the list record.
  const detail = await safe(() => client.getProject(project.id));
  if (detail) Object.assign(summary, sanitizeRecord(detail));

  const amounts = await safe(() => client.getProjectAmounts(project.id));
  if (amounts !== null) {
    summary.amounts = aggregateRows(amounts);
    sources.push("Endre API: project_amounts");
  }

  const cases = await safe(() => client.listProjectCases(project.id));
  if (cases !== null) {
    summary.cases = aggregateRows(cases);
    sources.push("Endre API: project_cases");
  }

  const contracts = await safe(() => client.listProjectContracts(project.id));
  if (contracts !== null) {
    summary.contracts = aggregateRows(contracts);
    sources.push("Endre API: project_contracts");
  }

  const tags = await safe(() => client.getProjectTags(project.id));
  if (tags !== null) {
    summary.tags = extractNames(tags);
    sources.push("Endre API: project_tags");
  }

  const orgs = await safe(() => client.listProjectOrganizations(project.id));
  if (orgs !== null) {
    summary.organizations = extractNames(orgs);
    sources.push("Endre API: project_organizations");
  }

  return { context: { endre_project: summary }, sources };
}

/**
 * Build model context for a project question from live Endre data.
 *
 * @returns a context block + source labels, or `null` to signal the caller to
 *          fall back to Firebase / uploaded documents. Never throws.
 */
export async function buildEndreProjectContext(
  message: string,
  client: EndreClient,
  diag?: EndreDiagnostics,
): Promise<EndreProjectResult | null> {
  if (diag) {
    diag.projectQuery = extractProjectQuery(message);
    diag.attemptedEndre = true;
  }

  const listRaw = await safe(() => client.listProjects());
  if (listRaw === null) {
    if (diag) diag.fallbackReason = "endre_list_unavailable";
    return null; // Endre unavailable → fall back.
  }

  const projects = toArray(listRaw)
    .map(toProjectLike)
    .filter((p): p is ProjectLike => p !== null);
  if (projects.length === 0) {
    if (diag) diag.fallbackReason = "no_projects_in_endre";
    return null;
  }

  const resolution = resolveProject(message, null, projects);
  if (resolution.status === "resolved") {
    const project = projects.find((p) => p.id === resolution.projectId);
    if (project) {
      if (diag) diag.endreFound = true;
      return buildSingleProjectSummary(client, project);
    }
  }

  // Field-name-agnostic fallback: match the project-number token against any
  // scalar field, so a number under a non-standard field name still resolves.
  const token = extractProjectQuery(message);
  if (token) {
    const direct = matchByNumberToken(projects, token);
    if (direct) {
      if (diag) diag.endreFound = true;
      return buildSingleProjectSummary(client, direct);
    }
  }

  // A specific project was named but Endre doesn't have it → fall back so
  // Firebase still gets a chance to answer.
  if (referencesSpecificProject(message)) {
    if (diag) diag.fallbackReason = "project_not_found_in_endre";
    return null;
  }

  // General "which projects exist?" question → answer from the Endre list.
  if (diag) diag.endreFound = true;
  return {
    context: {
      endre_projects: projects.slice(0, MAX_PROJECTS_LISTED).map(withoutId),
    },
    sources: ["Endre API: projects"],
  };
}

/**
 * Admin debug helper: coerce an Endre project-list payload into a sanitized,
 * query-filtered view. Matching scans every short scalar field (case-insensitive
 * substring) so it reveals which projects exist and under which field names —
 * without ever exposing raw payloads, ids, tokens, or credentials (every record
 * is run through `sanitizeRecord`, which drops nested data and secret-like keys).
 */
export function findEndreProjects(
  listRaw: unknown,
  query: string,
): EndreProjectDebugResult {
  const all = toArray(listRaw).map(sanitizeRecord);
  const q = query.trim().toLowerCase();
  const matches = q
    ? all.filter((p) =>
        Object.values(p).some(
          (value) =>
            (typeof value === "string" || typeof value === "number") &&
            String(value).toLowerCase().includes(q),
        ),
      )
    : all;
  return {
    total: all.length,
    count: matches.length,
    projects: matches.slice(0, MAX_PROJECTS_LISTED),
  };
}
