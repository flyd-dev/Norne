/**
 * Firestore client factory.
 *
 * Picks the backend based on which credentials are configured:
 *   - Admin SDK   (preferred) when a service-account key is present
 *   - REST        (fallback)  when only email/password + web API key is present
 *
 * The chosen client is memoised for the lifetime of the server process.
 */

import "server-only";
import { detectFirestoreBackend } from "@/lib/env";
import { createAdminFirestoreClient } from "@/lib/firestore/adminClient";
import { createRestFirestoreClient } from "@/lib/firestore/restClient";
import type { FirestoreClient } from "@/lib/firestore/types";

let client: FirestoreClient | undefined;

export function getFirestoreClient(): FirestoreClient {
  if (client) return client;

  const backend = detectFirestoreBackend();
  switch (backend) {
    case "admin":
      client = createAdminFirestoreClient();
      break;
    case "rest":
      client = createRestFirestoreClient();
      break;
    default:
      throw new Error(
        "No Firestore credentials configured. Set either the Admin SDK vars " +
          "(FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY) or the REST vars " +
          "(FIREBASE_API_KEY + FIREBASE_AUTH_EMAIL + FIREBASE_AUTH_PASSWORD).",
      );
  }
  return client;
}
