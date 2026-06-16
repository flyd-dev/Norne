/**
 * Firebase Admin SDK initialisation.
 *
 * Server-side ONLY. The Admin SDK uses a service-account private key and bypasses
 * Firestore security rules, so it must never be imported into client code.
 *
 * Requires a service account (Option A in .env.example):
 *   - FIREBASE_PROJECT_ID
 *   - FIREBASE_CLIENT_EMAIL
 *   - FIREBASE_PRIVATE_KEY
 *
 * If you only have an email/password + web API key, the Admin SDK cannot be used;
 * the app falls back to the REST client instead (see lib/firestore/restClient.ts).
 */

import "server-only";
import { cert, getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { env } from "@/lib/env";

const APP_NAME = "norne-chatbot-admin";

/**
 * Returns the singleton Admin app. Reusing the named app avoids the
 * "duplicate app" error during Next.js dev hot-reloads.
 */
export function getAdminApp(): App {
  const existing = getApps().find((app) => app.name === APP_NAME);
  if (existing) return existing;

  const clientEmail = env.firebase.clientEmail();
  const privateKey = env.firebase.privateKey();

  if (!clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin SDK is not configured. Set FIREBASE_CLIENT_EMAIL and " +
        "FIREBASE_PRIVATE_KEY (service account), or use the REST backend instead.",
    );
  }

  return initializeApp(
    {
      credential: cert({
        projectId: env.firebase.projectId(),
        clientEmail,
        privateKey,
      }),
    },
    APP_NAME,
  );
}

let firestore: Firestore | undefined;

/** Returns a memoised Admin Firestore instance. */
export function getAdminFirestore(): Firestore {
  if (!firestore) {
    firestore = getFirestore(getAdminApp());
  }
  return firestore;
}

// Re-export so callers can pass the same app name if they ever need getApp().
export { getApp };
