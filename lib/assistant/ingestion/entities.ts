/**
 * Unified entity ingestion (plan point 5): map Endre records AND Firestore docs
 * into ONE typed shape (Project / Account), so the tools and runner read a single
 * domain model regardless of source. Field names are matched case- and
 * separator-insensitively (Endre's PascalCase `ProjectNumber`, Firestore's
 * snake_case `project_number`), and only scalar fields are kept.
 *
 * Pure and dependency-free.
 */

import type { Project } from "@/lib/assistant/domain/project";
import type { Account } from "@/lib/assistant/domain/account";

/** Normalize a field name for case- and separator-insensitive comparison. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9æøå]/g, "");
}

/** Build a normalized-key → value index over a record (first key of a kind wins). */
function index(record: Record<string, unknown>): Map<string, unknown> {
  const idx = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    const norm = normalizeKey(key);
    if (!idx.has(norm)) idx.set(norm, value);
  }
  return idx;
}

/** First present candidate field, coerced to a trimmed string, else null. */
function pickString(
  idx: Map<string, unknown>,
  candidates: string[],
): string | null {
  for (const c of candidates) {
    const v = idx.get(normalizeKey(c));
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Keep only scalar fields (drop nested objects/arrays). */
function scalarFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    } else {
      // Preserve already-aggregated objects (amounts/contracts/cases) so metric
      // tools can still see them, but don't deep-copy arbitrary structures.
      out[key] = value;
    }
  }
  return out;
}

const NUMBER_FIELDS = ["project_number", "projectNumber", "number", "prosjektnummer"];
const NAME_FIELDS = ["project_name", "projectName", "name", "navn", "title", "prosjektnavn"];

/** Map an Endre or Firestore project record to the canonical Project. */
export function toProject(
  record: Record<string, unknown>,
  source: "endre" | "firebase",
): Project {
  const idx = index(record);
  return {
    projectNumber: pickString(idx, NUMBER_FIELDS),
    projectName: pickString(idx, NAME_FIELDS),
    fields: scalarFields(record),
    source,
  };
}

const ACCOUNT_NUMBER_FIELDS = ["account_number", "accountNumber", "kontonummer", "konto", "number"];
const ACCOUNT_NAME_FIELDS = ["name", "navn", "account_name", "kontonavn", "beskrivelse", "description", "title"];

/** Map a chart-of-accounts record to the canonical Account. */
export function toAccount(record: Record<string, unknown>): Account {
  const idx = index(record);
  return {
    accountNumber: pickString(idx, ACCOUNT_NUMBER_FIELDS),
    name: pickString(idx, ACCOUNT_NAME_FIELDS),
    fields: scalarFields(record),
  };
}
