/**
 * Shared Turso (libSQL) client for the "cloud" storage backend.
 *
 * One memoised HTTP client, reused by the vector store and the app-state stores
 * (documents, dossier, feedback, sharepoint sync) so a serverless instance opens
 * a single connection. Server-side only.
 *
 * The cloud backend stores everything the app WRITES in Turso — domain data
 * (accounts/projects) stays in Firestore, read via lib/firestore. So the cloud
 * backend needs no Firebase service account; Firebase keeps its existing
 * (REST) read-only setup.
 */

import "server-only";
import { env } from "@/lib/env";
import type { Client } from "@libsql/client";

let client: Client | null = null;

export async function getTursoClient(): Promise<Client> {
  if (client) return client;
  const url = env.turso.url();
  const authToken = env.turso.authToken();
  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set, but the cloud storage backend needs it. " +
        "Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN).",
    );
  }
  const { createClient } = await import("@libsql/client");
  client = createClient({ url, ...(authToken ? { authToken } : {}) });
  return client;
}

/** Close the shared client (tests / scripts). */
export function closeTursoClient(): void {
  if (client) {
    client.close();
    client = null;
  }
}
