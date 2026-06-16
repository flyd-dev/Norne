/**
 * FirestoreClient implementation backed by the Firebase Admin SDK.
 * Preferred backend. Used when a service-account key is configured.
 */

import "server-only";
import { getAdminFirestore } from "@/lib/firebaseAdmin";
import type { FirestoreClient, FirestoreDoc } from "@/lib/firestore/types";

export function createAdminFirestoreClient(): FirestoreClient {
  const db = getAdminFirestore();

  return {
    async listCollection(collection, limit) {
      const base = db.collection(collection);
      const query = typeof limit === "number" ? base.limit(limit) : base;
      const snap = await query.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FirestoreDoc);
    },

    async getDocument(collection, id) {
      const doc = await db.collection(collection).doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() } as FirestoreDoc;
    },

    async listSubcollection(parentCollection, parentId, subcollection) {
      const snap = await db
        .collection(parentCollection)
        .doc(parentId)
        .collection(subcollection)
        .get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FirestoreDoc);
    },
  };
}
