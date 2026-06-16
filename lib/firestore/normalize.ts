/**
 * Data minimization for the model context.
 *
 * Firestore documents can be large and nested; we never send raw documents to
 * OpenAI. These helpers extract only compact scalar fields, truncate long
 * strings, drop nested structures, and aggregate large row sets (budget lines /
 * quantities) into counts + numeric totals + a small sample.
 *
 * Pure and dependency-free for easy testing.
 */

import { projectLabel, type ProjectLike } from "@/lib/chat/projectResolver";
import type { FirestoreDoc } from "@/lib/firestore/types";

/** Max length of any string field sent to the model. */
export const MAX_STRING_LEN = 300;
/** Max number of scalar fields kept per document. */
export const MAX_SCALAR_FIELDS = 24;
/** Max number of sample rows included when aggregating a collection. */
export const MAX_SAMPLE_ROWS = 10;

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function truncate(value: string): string {
  return value.length > MAX_STRING_LEN
    ? `${value.slice(0, MAX_STRING_LEN)}…`
    : value;
}

/**
 * Keep only scalar fields (string/number/boolean/null), truncate long strings,
 * drop nested objects and arrays, and cap the number of fields.
 */
export function compactScalars(
  doc: FirestoreDoc,
  maxFields: number = MAX_SCALAR_FIELDS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(doc)) {
    if (key === "id") continue;
    if (!isScalar(value)) continue;
    out[key] = typeof value === "string" ? truncate(value) : value;
    if (++count >= maxFields) break;
  }
  return out;
}

/** Matches internal id-like field names (id, *_id, *_uid). */
const ID_FIELD = /(^id$)|(_id$)|(_uid$)/i;

/** Remove internal id-like fields from a flat object. */
function dropIdFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!ID_FIELD.test(key)) out[key] = value;
  }
  return out;
}

export function normalizeAccount(
  doc: FirestoreDoc,
  includeIds = true,
): Record<string, unknown> {
  const scalars = compactScalars(doc);
  return includeIds ? { id: doc.id, ...scalars } : dropIdFields(scalars);
}

export function normalizeProject(
  doc: FirestoreDoc,
  includeIds = true,
): Record<string, unknown> {
  const name = projectLabel(doc as ProjectLike);
  const scalars = compactScalars(doc);
  // When ids are not requested, omit the document id and any *_id/*_uid fields so
  // the model cannot surface internal identifiers in the answer.
  return includeIds
    ? { id: doc.id, name, ...scalars }
    : { name, ...dropIdFields(scalars) };
}

export interface RowSummary {
  /** Total number of rows in the collection (before sampling). */
  count: number;
  /** Sum of each numeric field across ALL rows. */
  totals: Record<string, number>;
  /** A small compacted sample of rows for context. */
  sample: Record<string, unknown>[];
  /** True when more rows exist than are included in `sample`. */
  truncated: boolean;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Aggregate a potentially large set of rows (budget lines / quantities) into a
 * compact summary: row count, per-field numeric totals, and a small sample.
 * This keeps token usage bounded regardless of how many rows exist.
 */
export interface SummarizeOptions {
  maxSample?: number;
  /** Include row document ids in the sample (default true). */
  includeIds?: boolean;
}

export function summarizeRows(
  rows: FirestoreDoc[],
  options: SummarizeOptions = {},
): RowSummary {
  const { maxSample = MAX_SAMPLE_ROWS, includeIds = true } = options;

  const totals: Record<string, number> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key === "id") continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
  }
  for (const key of Object.keys(totals)) {
    totals[key] = roundMoney(totals[key]);
  }

  const sample = rows.slice(0, maxSample).map((row) => {
    const scalars = compactScalars(row);
    return includeIds ? { id: row.id, ...scalars } : dropIdFields(scalars);
  });

  return {
    count: rows.length,
    totals,
    sample,
    truncated: rows.length > maxSample,
  };
}
