/**
 * FirestoreClient implementation backed by the Firestore REST API.
 *
 * Fallback backend for when no service-account key is available — it signs in
 * with an email/password Firebase Auth user (web API key) to obtain a bearer
 * token, then calls the Firestore REST endpoints. This matches the flow in
 * api-service-account.md.
 *
 * Server-side ONLY: the API key, email and password live in server env vars and
 * must never reach the browser.
 */

import "server-only";
import { env } from "@/lib/env";
import type { FirestoreClient, FirestoreDoc } from "@/lib/firestore/types";

const IDENTITY_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

function firestoreBaseUrl(projectId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

// --- Token cache (module-level, reused across requests) ----------------------

interface CachedToken {
  idToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

async function getIdToken(): Promise<string> {
  const now = Date.now();
  // Refresh a minute early to avoid edge-of-expiry failures.
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.idToken;
  }

  const apiKey = env.firebase.apiKey();
  const email = env.firebase.authEmail();
  const password = env.firebase.authPassword();
  if (!apiKey || !email || !password) {
    throw new Error(
      "REST backend is not configured. Set FIREBASE_API_KEY, FIREBASE_AUTH_EMAIL " +
        "and FIREBASE_AUTH_PASSWORD.",
    );
  }

  const res = await fetch(`${IDENTITY_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  if (!res.ok) {
    // Do NOT log the response body verbatim — it may echo the email. Keep it terse.
    throw new Error(`Firebase sign-in failed (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as { idToken: string; expiresIn: string };
  const expiresInMs = Number(data.expiresIn ?? "3600") * 1000;
  cachedToken = { idToken: data.idToken, expiresAt: now + expiresInMs };
  return cachedToken.idToken;
}

// --- Firestore REST value decoding -------------------------------------------

/** Decode a single Firestore REST typed value into a plain JS value. */
function decodeValue(value: Record<string, unknown>): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue as boolean;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue as number;
  if ("stringValue" in value) return value.stringValue as string;
  if ("timestampValue" in value) return value.timestampValue as string;
  if ("bytesValue" in value) return value.bytesValue as string;
  if ("referenceValue" in value) {
    // Reduce a document reference to its id (last path segment).
    const ref = value.referenceValue as string;
    return ref.split("/").pop() ?? ref;
  }
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) {
    const arr = (value.arrayValue as { values?: Record<string, unknown>[] }).values ?? [];
    return arr.map((v) => decodeValue(v));
  }
  if ("mapValue" in value) {
    const fields = (value.mapValue as { fields?: Record<string, Record<string, unknown>> }).fields ?? {};
    return decodeFields(fields);
  }
  return null;
}

/** Decode a Firestore REST `fields` object into a plain JS object. */
function decodeFields(
  fields: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = decodeValue(value);
  }
  return out;
}

interface RestDocument {
  name?: string; // full resource path; last segment is the id
  fields?: Record<string, Record<string, unknown>>;
}

function toDoc(raw: RestDocument): FirestoreDoc {
  const id = raw.name?.split("/").pop() ?? "";
  return { id, ...decodeFields(raw.fields ?? {}) };
}

// --- Firestore REST value encoding (for writes) ------------------------------

function encodeValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
  }
  return { stringValue: String(value) };
}

function encodeFields(
  data: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = encodeValue(value);
  }
  return fields;
}

// --- REST fetch helpers ------------------------------------------------------

async function firestoreGet(path: string): Promise<unknown> {
  const token = await getIdToken();
  const url = `${firestoreBaseUrl(env.firebase.projectId())}/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { documents: [] };
  if (!res.ok) {
    throw new Error(`Firestore REST request failed (HTTP ${res.status}).`);
  }
  return res.json();
}

async function listDocuments(path: string, limit?: number): Promise<FirestoreDoc[]> {
  // The list endpoint paginates; follow nextPageToken until exhausted (or limit).
  const docs: FirestoreDoc[] = [];
  let pageToken: string | undefined;
  do {
    const remaining = typeof limit === "number" ? limit - docs.length : undefined;
    if (remaining !== undefined && remaining <= 0) break;
    const pageSize = remaining !== undefined ? Math.min(remaining, 300) : 300;
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) params.set("pageToken", pageToken);
    const data = (await firestoreGet(`${path}?${params.toString()}`)) as {
      documents?: RestDocument[];
      nextPageToken?: string;
    };
    for (const raw of data.documents ?? []) docs.push(toDoc(raw));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return typeof limit === "number" ? docs.slice(0, limit) : docs;
}

async function firestorePatch(
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  const token = await getIdToken();
  const url = `${firestoreBaseUrl(env.firebase.projectId())}/${path}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!res.ok) {
    throw new Error(`Firestore REST write failed (HTTP ${res.status}).`);
  }
}

async function firestoreDelete(path: string): Promise<void> {
  const token = await getIdToken();
  const url = `${firestoreBaseUrl(env.firebase.projectId())}/${path}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Firestore REST delete failed (HTTP ${res.status}).`);
  }
}

// --- FirestoreClient implementation ------------------------------------------

export function createRestFirestoreClient(): FirestoreClient {
  return {
    async listCollection(collection, limit) {
      return listDocuments(collection, limit);
    },

    async getDocument(collection, id) {
      try {
        const raw = (await firestoreGet(`${collection}/${id}`)) as RestDocument;
        if (!raw.name) return null;
        return toDoc(raw);
      } catch {
        return null;
      }
    },

    async listSubcollection(parentCollection, parentId, subcollection) {
      return listDocuments(`${parentCollection}/${parentId}/${subcollection}`);
    },

    async createDocument(collection, id, data) {
      await firestorePatch(`${collection}/${id}`, data);
    },

    async createSubDocuments(parentCollection, parentId, subcollection, items) {
      // REST has no batch write; create sequentially (fine for MVP volumes).
      for (const item of items) {
        await firestorePatch(
          `${parentCollection}/${parentId}/${subcollection}/${item.id}`,
          item.data,
        );
      }
    },

    async deleteDocumentWithSubcollection(collection, id, subcollection) {
      const chunks = await listDocuments(`${collection}/${id}/${subcollection}`);
      for (const chunk of chunks) {
        await firestoreDelete(`${collection}/${id}/${subcollection}/${chunk.id}`);
      }
      await firestoreDelete(`${collection}/${id}`);
    },
  };
}
