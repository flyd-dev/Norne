/**
 * Firestore-backed persistence for the app's OWN state — the data that lives in
 * local JSON/SQLite files on the VPS but needs a hosted home on serverless
 * (Vercel), where there is no persistent filesystem. Selected via
 * STORE_BACKEND=cloud; the "local" backend never imports this module.
 *
 * This is separate from the read-only DOMAIN data (accounts/projects) served by
 * lib/firestore/service.ts. App state needs writes, so it uses the Admin SDK
 * directly — meaning the cloud backend REQUIRES Admin SDK mode
 * (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY), not the REST fallback.
 *
 * Collections are namespaced with a `norne_` prefix so they can never collide
 * with domain collections.
 *
 * Server-side only.
 */

import "server-only";
import { getAdminFirestore } from "@/lib/firebaseAdmin";

export const APP_COLLECTIONS = {
  /** Single-doc app state (dossier, sharepoint sync cursor). */
  state: "norne_app_state",
  /** One doc per uploaded/synced knowledge document. */
  documents: "norne_knowledge_documents",
  /** One doc per feedback record (auto id). */
  feedback: "norne_feedback",
} as const;

/** Read a single state document by id, or null when it doesn't exist. */
export async function readStateDoc<T>(id: string): Promise<T | null> {
  const snap = await getAdminFirestore()
    .collection(APP_COLLECTIONS.state)
    .doc(id)
    .get();
  return snap.exists ? (snap.data() as T) : null;
}

/** Write (replace) a single state document by id. */
export async function writeStateDoc<T extends Record<string, unknown>>(
  id: string,
  data: T,
): Promise<void> {
  await getAdminFirestore()
    .collection(APP_COLLECTIONS.state)
    .doc(id)
    .set(data);
}
