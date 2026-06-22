/**
 * Minimal Microsoft Graph client for read-only SharePoint sync (app-only auth).
 *
 * Uses the OAuth2 client-credentials flow against the Entra ID tenant, then the
 * Graph v1.0 endpoints needed to walk a site's document libraries:
 *
 *   - token:   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   - site id: GET  /sites/{hostname}:/{path}
 *   - drives:  GET  /sites/{siteId}/drives
 *   - delta:   GET  /drives/{driveId}/root/delta            (incremental listing)
 *   - content: GET  /drives/{driveId}/items/{itemId}/content
 *
 * No secrets are logged. Server-side only.
 */

import "server-only";
import { env } from "@/lib/env";
import type { GraphDelta, GraphDrive, GraphDriveItem } from "@/lib/sharepoint/types";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Cached app-only token (per process), refreshed shortly before expiry. */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  const tenant = env.sharepoint.tenantId();
  const clientId = env.sharepoint.clientId();
  const clientSecret = env.sharepoint.clientSecret();
  if (!tenant || !clientId || !clientSecret) {
    throw new Error("SharePoint credentials are not configured.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`Graph token request failed (HTTP ${res.status}).`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Graph token response missing access_token.");
  }
  cachedToken = {
    value: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function graphGet<T>(urlOrPath: string): Promise<T> {
  const token = await getAccessToken();
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${GRAPH}${urlOrPath}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Graph GET failed (HTTP ${res.status}) for ${new URL(url).pathname}.`);
  }
  return (await res.json()) as T;
}

/** Resolve the configured site (`{host}:/sites/{path}`) to its Graph site id. */
export async function resolveSiteId(): Promise<string> {
  const site = env.sharepoint.site();
  if (!site) throw new Error("SHAREPOINT_SITE is not configured.");
  // Graph expects /sites/{hostname}:/sites/{path}: the value is used verbatim.
  const data = await graphGet<{ id: string }>(`/sites/${site}`);
  return data.id;
}

/** List the document libraries (drives) on a site. */
export async function listDrives(siteId: string): Promise<GraphDrive[]> {
  const data = await graphGet<{ value: GraphDrive[] }>(`/sites/${siteId}/drives`);
  return data.value;
}

/**
 * Fetch one page of a drive's delta feed. Pass the previous deltaLink/nextLink
 * to continue; pass undefined to start a full enumeration. Returns the items on
 * this page plus the link to use next (nextLink while paging, deltaLink when the
 * page is the last one — store the deltaLink for the next incremental sync).
 */
export async function deltaPage(
  driveId: string,
  link?: string,
): Promise<{ items: GraphDriveItem[]; nextLink?: string; deltaLink?: string }> {
  const data = await graphGet<GraphDelta>(
    link ?? `/drives/${driveId}/root/delta`,
  );
  return {
    items: data.value ?? [],
    nextLink: data["@odata.nextLink"],
    deltaLink: data["@odata.deltaLink"],
  };
}

/** Download a drive item's binary content. */
export async function downloadItem(
  driveId: string,
  itemId: string,
): Promise<Buffer> {
  const token = await getAccessToken();
  const res = await fetch(
    `${GRAPH}/drives/${driveId}/items/${itemId}/content`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`Graph download failed (HTTP ${res.status}).`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Reset the cached token (tests). */
export function resetGraphToken(): void {
  cachedToken = null;
}
