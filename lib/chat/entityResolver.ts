/**
 * Entity (project) resolution across every available signal.
 *
 * A capable assistant resolves "Pilestredet prosjektet", "prosjekt 7100" or a
 * bare "kontraktsverdien?" follow-up to the SAME project, drawing on:
 *   - an explicit project number in the message,
 *   - a project name in the message (matched against known projects, or a
 *     "<Name> prosjektet" / "prosjekt <Name>" phrasing when no list is given),
 *   - the projects list (Firestore or Endre),
 *   - facts established earlier in the conversation (history).
 *
 * Pure and dependency-free. Project-list resolution reuses resolveProject so the
 * id/name matching rules stay in one place.
 */

import {
  resolveProject,
  projectLabel,
  PROJECT_NAME_FIELDS,
  type ProjectLike,
} from "@/lib/chat/projectResolver";
import { extractHistoryFacts, type HistoryMessage } from "@/lib/chat/historyFacts";

export type ResolverConfidence = "high" | "medium" | "low";

export interface ResolvedEntity {
  projectNumber: string | null;
  projectName: string | null;
  /** The resolved project's document id, when a list match was found. */
  projectId: string | null;
  confidence: ResolverConfidence;
  /** Where each signal came from, for diagnostics. */
  matchedFrom: string[];
}

export interface ResolveEntityInput {
  message: string;
  history?: HistoryMessage[];
  /** Known projects (Firestore and/or Endre), used for authoritative matching. */
  projects?: ProjectLike[];
}

const PROJECT_NUMBER_LABELLED =
  /\bprosjekt(?:nummer|nr)?\.?\s*[:=]?\s*(\d{3,6})\b/i;
const PROJECT_NUMBER_INLINE = /\bprosjekt\w*\s+(\d{3,6})\b/i;
// A standalone number, NOT part of a decimal/grouped number (e.g. the "000" in
// "29.000") and not a percentage.
const BARE_NUMBER = /(?<![\d.,%])\b(\d{3,6})\b(?![\d.,%])/;
// A four-digit year (2000–2099). A bare year is a time reference, never a project
// number — "frem til september 2026" must not resolve to "prosjekt 2026".
const YEAR_RE = /^20\d{2}$/;

// "<Name> prosjektet" / "prosjekt <Name>" — a capitalised one/two word name.
const NAME_BEFORE_PROSJEKT =
  /\b([A-ZÆØÅ][\wæøåÆØÅ-]+(?:\s+[A-ZÆØÅ][\wæøåÆØÅ-]+)?)[-\s]?prosjektet\b/;
const NAME_AFTER_PROSJEKT =
  /\bprosjekt(?:et)?\s+["«]?([A-ZÆØÅ][\wæøåÆØÅ-]+(?:\s+[A-ZÆØÅ][\wæøåÆØÅ-]+)?)/;

/** Extract a project number explicitly written in the message text. */
export function extractProjectNumberFromText(text: string): string | null {
  // Labelled/inline forms require the word "prosjekt", so a year there is an
  // explicit (if odd) project reference and is kept. A BARE number, however, is
  // only a project number when it is not a 4-digit year.
  const labelled =
    text.match(PROJECT_NUMBER_LABELLED)?.[1] ??
    text.match(PROJECT_NUMBER_INLINE)?.[1];
  if (labelled) return labelled;
  const bare = text.match(BARE_NUMBER)?.[1];
  if (bare && !YEAR_RE.test(bare)) return bare;
  return null;
}

/**
 * Extract ALL distinct project-number tokens from the message (3–6 digits),
 * dropping 4-digit years. Used to detect a multi-project question ("sammenlign
 * 7100 og 3025"). Order-preserving, de-duplicated.
 */
export function extractProjectNumbersFromText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?<![\d.,%])\b(\d{3,6})\b(?![\d.,%])/g;
  for (const m of text.matchAll(re)) {
    const tok = m[1];
    if (YEAR_RE.test(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Extract a candidate project NAME from the message text alone (no list). Used
 * so the Endre source can tell a specific-project question ("kontraktsverdi på
 * Pilestredet prosjektet") apart from a general "which projects exist?" one,
 * even before any project list is loaded. Numbers are never returned as names.
 */
export function extractProjectNameFromText(text: string): string | null {
  const before = text.match(NAME_BEFORE_PROSJEKT)?.[1]?.trim();
  if (before && !/^\d+$/.test(before)) return before;
  const after = text.match(NAME_AFTER_PROSJEKT)?.[1]?.trim();
  if (after && !/^\d+$/.test(after)) return after;
  return null;
}

/** Read a project's number/name from its document fields. */
function fieldsOf(project: ProjectLike): { number: string | null; name: string } {
  const number =
    typeof project.project_number === "string"
      ? project.project_number
      : typeof project.project_number === "number"
        ? String(project.project_number)
        : null;
  return { number, name: projectLabel(project) };
}

/**
 * Find a project in the list whose number matches the token, scanning the
 * canonical name fields (project_number lives there) and any scalar field.
 */
function findByNumber(
  projects: ProjectLike[],
  token: string,
): ProjectLike | null {
  for (const project of projects) {
    for (const field of PROJECT_NAME_FIELDS) {
      if (String(project[field] ?? "").trim() === token) return project;
    }
  }
  return null;
}

/**
 * Resolve which project a message refers to, combining the message, the projects
 * list (when given) and the conversation history. Returns the best-known number
 * and name plus a confidence and provenance trail.
 */
export function resolveEntity(input: ResolveEntityInput): ResolvedEntity {
  const { message, history = [], projects = [] } = input;
  const matchedFrom: string[] = [];

  let projectNumber = extractProjectNumberFromText(message);
  let projectName = extractProjectNameFromText(message);
  let projectId: string | null = null;
  if (projectNumber || projectName) matchedFrom.push("message");

  // 1. Authoritative match against the projects list.
  if (projects.length > 0) {
    const resolution = resolveProject(message, null, projects);
    let hit: ProjectLike | null = null;
    if (resolution.status === "resolved") {
      hit = projects.find((p) => p.id === resolution.projectId) ?? null;
    }
    // Fall back to a number-token match (covers non-standard name fields).
    if (!hit && projectNumber) hit = findByNumber(projects, projectNumber);

    if (hit) {
      const { number, name } = fieldsOf(hit);
      projectId = hit.id;
      if (number) projectNumber = number;
      if (name) projectName = name;
      matchedFrom.push("projects");
      return {
        projectNumber,
        projectName,
        projectId,
        confidence: "high",
        matchedFrom,
      };
    }
  }

  // 2. Fill gaps from history (elliptical follow-ups).
  if (!projectNumber || !projectName) {
    const facts = extractHistoryFacts(history);
    if (!projectNumber && facts.projectNumber) {
      projectNumber = facts.projectNumber;
      matchedFrom.push("history");
    }
    if (!projectName && facts.projectName) {
      projectName = facts.projectName;
      if (!matchedFrom.includes("history")) matchedFrom.push("history");
    }
  }

  let confidence: ResolverConfidence = "low";
  if (matchedFrom.includes("message") && (projectNumber || projectName)) {
    confidence = "high";
  } else if (projectNumber && projectName) {
    confidence = "high";
  } else if (projectNumber || projectName) {
    confidence = "medium";
  }

  return { projectNumber, projectName, projectId, confidence, matchedFrom };
}
