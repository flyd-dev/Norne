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
import {
  projectLabel,
  resolveProject,
  type ProjectLike,
} from "@/lib/chat/projectResolver";
import { compactScalars } from "@/lib/firestore/normalize";
import type { FirestoreDoc } from "@/lib/firestore/types";

/** Max projects included when answering a project-list question. */
const MAX_PROJECTS_LISTED = 50;
/** Max example rows kept from an amounts/cases/contracts collection. */
const MAX_SAMPLE_ROWS = 5;
/** Max tag/organization names kept. */
const MAX_NAMES = 25;

/**
 * Candidate fields that may hold a project's id, in priority order. Matched
 * case- and separator-insensitively (see `pickField`), so PascalCase (`Id`),
 * camelCase (`projectId`) and snake_case (`project_id`) all resolve.
 */
const ID_FIELDS = ["id", "project_id", "projectId", "uuid", "guid"] as const;
/**
 * Fields resolveProject matches on; coerced to strings so numeric values match.
 * Matched case- and separator-insensitively, so Endre's PascalCase fields
 * (`Name`, `ProjectName`, `ProjectNumber`) populate the canonical keys below.
 */
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
  /** Items returned by listProjects after shape-normalization (`toArray`). */
  projectListCount: number;
  /** Projects that survived `toProjectLike` (had a resolvable id). */
  normalizedProjectListCount: number;
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

/** Envelope keys that may directly carry the array of items. */
const ARRAY_ENVELOPE_KEYS = [
  "data",
  "items",
  "results",
  "projects",
  "value",
  "records",
  "content",
] as const;
/** Envelope keys that may wrap a nested response object (one level deeper). */
const NESTED_ENVELOPE_KEYS = [
  "data",
  "response",
  "result",
  "payload",
  "body",
] as const;

/**
 * Coerce an Endre list response into an array — the SINGLE shared normalization
 * used by both the chat path (`buildEndreProjectContext`) and the admin endpoint
 * (`findEndreProjects`), so the two can never disagree on how many projects Endre
 * returned. Handles:
 *   - a bare array,
 *   - a common envelope ({ data | items | results | projects | value | … : [...] }),
 *   - a nested response ({ data: { items: [...] } }, { response: { projects: [...] } }).
 * Exported for direct regression testing.
 */
export function toArray(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  if (!rec) return [];
  for (const key of ARRAY_ENVELOPE_KEYS) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  // Nested response: recurse one or two levels into envelope objects.
  if (depth < 2) {
    for (const key of NESTED_ENVELOPE_KEYS) {
      const nested = rec[key];
      if (nested && typeof nested === "object") {
        const arr = toArray(nested, depth + 1);
        if (arr.length > 0) return arr;
      }
    }
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

/** Normalize a field name for case- and separator-insensitive comparison. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Pick the first candidate field present in a record, matching field names
 * case- and separator-insensitively. This is what makes the integration robust
 * to Endre's PascalCase fields: candidate `"id"` matches key `"Id"`, candidate
 * `"project_number"` matches key `"ProjectNumber"`, and so on.
 */
function pickField(
  rec: Record<string, unknown>,
  index: Map<string, string>,
  candidates: readonly string[],
): unknown {
  for (const candidate of candidates) {
    const key = index.get(normalizeKey(candidate));
    if (key !== undefined) return rec[key];
  }
  return undefined;
}

/** True for id-like field names (id / *_id / *Id / *_uid / uuid / guid). */
function isIdLikeKey(key: string): boolean {
  return (
    /^(id|uuid|guid)$/i.test(key) ||
    /(_id|_uid)$/i.test(key) ||
    /[a-z]Id$/.test(key)
  );
}

/** Map an unknown Endre project object into a ProjectLike for resolveProject. */
function toProjectLike(value: unknown): ProjectLike | null {
  const rec = asRecord(value);
  if (!rec) return null;
  // Build a normalized-key index once so id/name lookups are case-insensitive.
  const index = new Map<string, string>();
  for (const key of Object.keys(rec)) {
    const norm = normalizeKey(key);
    if (!index.has(norm)) index.set(norm, key);
  }

  let id: string | undefined;
  const rawId = pickField(rec, index, ID_FIELDS);
  if (typeof rawId === "string" && rawId.trim()) id = rawId.trim();
  else if (typeof rawId === "number" && Number.isFinite(rawId)) id = String(rawId);
  if (!id) return null;

  const like: ProjectLike = { id, ...sanitizeRecord(rec) };
  // Populate the canonical name fields resolveProject matches on, reading them
  // case-insensitively (so `ProjectName` → `project_name`) and coercing to
  // strings (so a numeric project number still matches).
  for (const field of NAME_FIELDS) {
    const v = pickField(rec, index, [field]);
    if (v !== undefined && v !== null && typeof v !== "object") {
      like[field] = String(v);
    }
  }
  return like;
}

/**
 * Drop the internal id (and any other id-like field, e.g. a PascalCase `Id` or
 * `OrganizationId` preserved by sanitizeRecord) before a project reaches the
 * model. Keeps names/numbers, never leaks raw ids/guids.
 */
function withoutId(project: ProjectLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(project)) {
    if (key === "id" || isIdLikeKey(key)) continue;
    out[key] = value;
  }
  return out;
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
 * A project the caller has already resolved (from the message, a project list or
 * history). Lets the Endre source recognise a specific-project question even when
 * the project is named rather than numbered, and try the resolved number as an
 * extra match token. Optional so existing callers keep working.
 */
export interface ResolvedProjectHint {
  projectNumber?: string | null;
  projectName?: string | null;
}

/**
 * True when the question points at one specific project — a project number or
 * explicit document id in the message, OR a project the caller already resolved
 * by name/number. Used to decide whether a missing project should fall back to
 * Firebase (specific lookup) rather than answer with the whole project list.
 */
function referencesSpecificProject(
  message: string,
  hint?: ResolvedProjectHint,
): boolean {
  if (/\b\d{3,6}\b/.test(message) || /\b[A-Za-z0-9]{20}\b/.test(message)) {
    return true;
  }
  return Boolean(hint?.projectName || hint?.projectNumber);
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
  hint?: ResolvedProjectHint,
): Promise<EndreProjectResult | null> {
  if (diag) {
    diag.projectQuery = extractProjectQuery(message) ?? hint?.projectNumber ?? null;
    diag.attemptedEndre = true;
  }

  const listRaw = await safe(() => client.listProjects());
  if (listRaw === null) {
    if (diag) diag.fallbackReason = "endre_list_unavailable";
    return null; // Endre unavailable → fall back.
  }

  const rawList = toArray(listRaw);
  if (diag) diag.projectListCount = rawList.length;
  const projects = rawList
    .map(toProjectLike)
    .filter((p): p is ProjectLike => p !== null);
  if (diag) diag.normalizedProjectListCount = projects.length;
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
  // Try the message's own token first, then any number the caller resolved
  // (e.g. a number recovered from history for a name-only follow-up).
  for (const token of [extractProjectQuery(message), hint?.projectNumber]) {
    if (!token) continue;
    const direct = matchByNumberToken(projects, token);
    if (direct) {
      if (diag) diag.endreFound = true;
      return buildSingleProjectSummary(client, direct);
    }
  }

  // A specific project was named/numbered but Endre doesn't have it → fall back
  // so Firebase still gets a chance to answer. This now also covers a project
  // referenced purely by NAME (e.g. "kontraktsverdi på Pilestredet prosjektet"),
  // which previously slipped through and wrongly returned the whole Endre list.
  if (referencesSpecificProject(message, hint)) {
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
 * A project reduced to just its number and name, for combining the Endre list
 * with the Firestore/local list in the `project_list` route. Both fields may be
 * null when a source omits them.
 */
export interface ListedProject {
  projectNumber: string | null;
  projectName: string | null;
  /**
   * Internal document id, only ever populated for Firestore/local projects (the
   * caller exposes it solely when the user explicitly asks for an id). Endre ids
   * are never carried here.
   */
  id?: string | null;
}

/** Read an Endre project's number + display name (never its raw id) for listing. */
function toListedProject(project: ProjectLike): ListedProject {
  const rawNumber = project.project_number;
  const projectNumber =
    typeof rawNumber === "string" && rawNumber.trim()
      ? rawNumber.trim()
      : typeof rawNumber === "number" && Number.isFinite(rawNumber)
        ? String(rawNumber)
        : null;
  const label = projectLabel(project);
  // projectLabel falls back to the id when no name field exists — never surface
  // the internal id as a "name".
  const projectName = label && label !== project.id ? label : null;
  // Endre ids are never carried into the combined list.
  return { projectNumber, projectName, id: null };
}

/**
 * List every project Endre exposes, reduced to number + name, for the
 * `project_list` route. Returns null when Endre is unavailable (so the caller can
 * still answer from Firestore alone). Never throws, never leaks raw payloads/ids.
 */
export async function listEndreProjects(
  client: EndreClient,
): Promise<ListedProject[] | null> {
  const listRaw = await safe(() => client.listProjects());
  if (listRaw === null) return null;
  return toArray(listRaw)
    .map(toProjectLike)
    .filter((p): p is ProjectLike => p !== null)
    .map(toListedProject);
}

/**
 * Combine and deduplicate a set of listed projects. Dedupe key is the project
 * NUMBER first; when an entry has no number, its normalized (lowercased,
 * trimmed) NAME is used. Entries that match an existing project merge their
 * missing field in (e.g. an Endre record without a name + a local record with
 * one become a single complete entry). Input order is preserved.
 */
export function dedupeProjects(projects: ListedProject[]): ListedProject[] {
  const byNumber = new Map<string, number>();
  const byName = new Map<string, number>();
  const out: ListedProject[] = [];

  for (const project of projects) {
    const number = project.projectNumber?.trim() || null;
    const name = project.projectName?.trim() || null;
    const nameKey = name ? name.toLowerCase() : null;

    let idx: number | undefined;
    if (number && byNumber.has(number)) idx = byNumber.get(number);
    else if (nameKey && byName.has(nameKey)) idx = byName.get(nameKey);

    if (idx !== undefined) {
      const existing = out[idx];
      if (!existing.projectNumber && number) {
        existing.projectNumber = number;
        byNumber.set(number, idx);
      }
      if (!existing.projectName && name) {
        existing.projectName = name;
        byName.set(nameKey!, idx);
      }
      if (!existing.id && project.id) existing.id = project.id;
      continue;
    }

    const newIdx = out.length;
    out.push({ projectNumber: number, projectName: name, id: project.id ?? null });
    if (number) byNumber.set(number, newIdx);
    if (nameKey) byName.set(nameKey, newIdx);
  }

  return out;
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
