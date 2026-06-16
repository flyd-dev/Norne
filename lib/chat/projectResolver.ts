/**
 * Project resolution: turn a free-text mention of a project into a project id.
 *
 * Supports lookup by:
 *   - explicit Firestore document id (exact match against the projects list),
 *   - a project id mentioned inside the message text,
 *   - a human-readable project name in any of PROJECT_NAME_FIELDS.
 *
 * Pure and dependency-free so it is trivial to unit-test.
 */

/**
 * Candidate fields that may hold a project's human-readable name, in priority
 * order. Verified against the live `projects` schema (2026-06): the real fields
 * are `project_name` (full name) and `project_number` (short 4-char number).
 * The remaining generic fallbacks are kept for resilience to schema changes.
 *
 * Note: `project_manager_uid` is intentionally excluded — it is a user id, not a
 * project name.
 */
export const PROJECT_NAME_FIELDS = [
  "project_name",
  "project_number",
  "name",
  "navn",
  "title",
  "projectName",
  "displayName",
] as const;

export interface ProjectLike {
  id: string;
  [key: string]: unknown;
}

export type ProjectResolution =
  | { status: "resolved"; projectId: string; matchedBy: "id" | "name"; label: string }
  | { status: "not_found"; message: string }
  | { status: "ambiguous"; message: string; candidates: string[] };

/** Best human-readable label for a project (first present name field, else id). */
export function projectLabel(project: ProjectLike): string {
  for (const field of PROJECT_NAME_FIELDS) {
    const value = project[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return project.id;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

function availableList(projects: ProjectLike[], limit = 20): string {
  const list = projects
    .slice(0, limit)
    .map((p) => `${projectLabel(p)} (${p.id})`)
    .join(", ");
  return projects.length > limit ? `${list}, …` : list;
}

/**
 * Resolve which project a message refers to.
 *
 * @param message           the user's message text
 * @param explicitProjectId an id already extracted from the message (or null)
 * @param projects          the full list of known projects
 */
export function resolveProject(
  message: string,
  explicitProjectId: string | null,
  projects: ProjectLike[],
): ProjectResolution {
  const lower = message.toLowerCase();

  // 1. Explicit id token that matches a known project.
  if (explicitProjectId) {
    const hit = projects.find((p) => p.id === explicitProjectId);
    if (hit) {
      return {
        status: "resolved",
        projectId: hit.id,
        matchedBy: "id",
        label: projectLabel(hit),
      };
    }
  }

  // 2. Any known project id appearing in the message text.
  const idHits = dedupeById(
    projects.filter((p) => p.id.length >= 6 && lower.includes(p.id.toLowerCase())),
  );
  if (idHits.length === 1) {
    return {
      status: "resolved",
      projectId: idHits[0].id,
      matchedBy: "id",
      label: projectLabel(idHits[0]),
    };
  }
  if (idHits.length > 1) {
    const candidates = idHits.map((p) => `${projectLabel(p)} (${p.id})`);
    return {
      status: "ambiguous",
      message: `Flere prosjekter matcher. Presiser med prosjekt-ID: ${candidates.join(", ")}.`,
      candidates,
    };
  }

  // 3. Name matching across configurable name fields.
  const matches: { id: string; name: string }[] = [];
  for (const project of projects) {
    for (const field of PROJECT_NAME_FIELDS) {
      const value = project[field];
      if (
        typeof value === "string" &&
        value.trim().length >= 2 &&
        lower.includes(value.trim().toLowerCase())
      ) {
        matches.push({ id: project.id, name: value.trim() });
        break;
      }
    }
  }

  if (matches.length > 0) {
    // Prefer the longest matched name (handles "Bygg" vs "Bygg A").
    const maxLen = Math.max(...matches.map((m) => m.name.length));
    const top = dedupeById(matches.filter((m) => m.name.length === maxLen));
    if (top.length === 1) {
      return {
        status: "resolved",
        projectId: top[0].id,
        matchedBy: "name",
        label: top[0].name,
      };
    }
    const candidates = top.map((m) => `${m.name} (${m.id})`);
    return {
      status: "ambiguous",
      message: `Fant flere prosjekter med samme navn. Presiser med prosjekt-ID: ${candidates.join(", ")}.`,
      candidates,
    };
  }

  // 4. Nothing matched.
  if (explicitProjectId) {
    return {
      status: "not_found",
      message:
        `Fant ikke noe prosjekt med ID «${explicitProjectId}». ` +
        `Tilgjengelige prosjekter: ${availableList(projects)}.`,
    };
  }
  return {
    status: "not_found",
    message:
      `Fant ikke prosjektet du nevnte. ` +
      `Oppgi prosjekt-ID eller velg blant: ${availableList(projects)}.`,
  };
}
