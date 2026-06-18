/**
 * GET /api/admin/endre/status  (token-protected diagnostic)
 *
 * Reports the state of the OPTIONAL Endre API integration without exposing any
 * credentials, tokens, or raw payloads. Useful to confirm whether the live
 * integration can authenticate before wiring it into any answer path.
 *
 * Auth: Authorization: Bearer <ADMIN_UPLOAD_TOKEN> (same gate as other admin
 * routes). Server-side only.
 *
 * Response shape:
 *   {
 *     enabled: boolean,              // ENDRE_API_ENABLED flag
 *     configured: boolean,           // username + password present
 *     canAuthenticate: boolean,      // a live /token call succeeded
 *     availableCapabilities: string[], // GET endpoints this client supports
 *     error?: string                 // safe message if auth failed
 *   }
 */

import { NextResponse } from "next/server";
import { adminConfigured, isAdminAuthorized } from "@/lib/admin/auth";
import { endreConfigured, env } from "@/lib/env";
import { getEndreClient } from "@/lib/endre/client";
import { ENDRE_CAPABILITIES } from "@/lib/endre/types";
import { errorTypeOf, logAdminError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const result: {
    enabled: boolean;
    configured: boolean;
    canAuthenticate: boolean;
    availableCapabilities: string[];
    error?: string;
  } = {
    enabled,
    configured,
    canAuthenticate: false,
    availableCapabilities: [],
  };

  // Only attempt a live token call when both the flag is on and creds exist.
  const client = getEndreClient();
  if (!client) {
    return NextResponse.json(result, { status: 200 });
  }

  try {
    await client.verifyAuth();
    result.canAuthenticate = true;
    result.availableCapabilities = [...ENDRE_CAPABILITIES];
  } catch (error) {
    // Log by type only; reply with a safe, generic message (no secrets/tokens).
    logAdminError(requestId, "endre-status", error);
    result.error = `Autentisering mot Endre feilet (${errorTypeOf(error)}).`;
  }

  return NextResponse.json(result, { status: 200 });
}
