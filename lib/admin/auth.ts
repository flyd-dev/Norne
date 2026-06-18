/**
 * Admin authorization for the document-upload routes.
 *
 * Checks an `Authorization: Bearer <token>` header against ADMIN_UPLOAD_TOKEN
 * using a constant-time comparison. Server-side only — the token is never sent
 * to the browser; the browser supplies a token the user typed.
 */

import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** True when an admin upload token is configured at all. */
export function adminConfigured(): boolean {
  return Boolean(env.admin.uploadToken());
}

/** Validate the request's bearer token against ADMIN_UPLOAD_TOKEN. */
export function isAdminAuthorized(request: Request): boolean {
  const configured = env.admin.uploadToken();
  if (!configured) return false;

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(configured);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
