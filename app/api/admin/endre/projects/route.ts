/**
 * GET /api/admin/endre/projects?query=7100  (token-protected diagnostic)
 *
 * Lists the projects Endre actually returns, filtered by an optional `query`
 * (substring match across every short scalar field). Used to confirm whether a
 * given project (e.g. 7100) exists in Endre and under which field name its number
 * lives — the missing piece when the chat answer falls back to Firebase.
 *
 * Auth: Authorization: Bearer <ADMIN_UPLOAD_TOKEN> (same gate as other admin
 * routes). Server-side only.
 *
 * Safety: NEVER exposes raw payloads, tokens, credentials, ids, or internal
 * error details. Projects are sanitized via `findEndreProjects` (short scalars
 * only, secret-like keys dropped); failures return a generic, typed message.
 *
 * Response shape:
 *   {
 *     enabled: boolean,
 *     configured: boolean,
 *     query: string,
 *     total: number,            // projects returned by Endre
 *     count: number,            // matching the query
 *     projects: object[],       // sanitized matches only
 *     error?: string            // safe message if the lookup failed
 *   }
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import { endreConfigured, env } from "@/lib/env";
import { getEndreClient } from "@/lib/endre/client";
import { findEndreProjects } from "@/lib/chat/endreSource";
import { errorTypeOf, logAdminError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cap the query length defensively; a project number is short. */
const MAX_QUERY_LENGTH = 64;

function guard(request: Request) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "Adminfunksjoner er ikke konfigurert på serveren." },
      { status: 503 },
    );
  }
  if (!isAdminAuthorized(request)) {
    return NextResponse.json({ error: "Ikke autorisert." }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;

  const requestId = newRequestId();
  const enabled = env.endre.enabledFlag();
  const configured = endreConfigured();
  const query = (new URL(request.url).searchParams.get("query") ?? "")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);

  const result: {
    enabled: boolean;
    configured: boolean;
    query: string;
    total: number;
    count: number;
    projects: Record<string, unknown>[];
    error?: string;
  } = {
    enabled,
    configured,
    query,
    total: 0,
    count: 0,
    projects: [],
  };

  const client = getEndreClient();
  if (!client) {
    // Flag off or creds missing — report state without attempting a call.
    return NextResponse.json(result, { status: 200 });
  }

  try {
    const listRaw = await client.listProjects();
    const found = findEndreProjects(listRaw, query);
    result.total = found.total;
    result.count = found.count;
    result.projects = found.projects;
  } catch (error) {
    // Log by type only; reply with a safe, generic message (no secrets/tokens).
    logAdminError(requestId, "endre-projects", error);
    result.error = `Henting av prosjekter fra Endre feilet (${errorTypeOf(error)}).`;
  }

  return NextResponse.json(result, { status: 200 });
}
