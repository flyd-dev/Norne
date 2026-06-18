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

    async createDocument(collection, id, data) {
      await db.collection(collection).doc(id).set(data);
    },

    async createSubDocuments(parentCollection, parentId, subcollection, items) {
      const parent = db.collection(parentCollection).doc(parentId);
      // Firestore batches are limited to 500 writes.
      const BATCH = 450;
      for (let i = 0; i < items.length; i += BATCH) {
        const batch = db.batch();
        for (const item of items.slice(i, i + BATCH)) {
          batch.set(parent.collection(subcollection).doc(item.id), item.data);
        }
        await batch.commit();
      }
    },

    async deleteDocumentWithSubcollection(collection, id, subcollection) {
      const ref = db.collection(collection).doc(id);
      const snap = await ref.collection(subcollection).get();
      const BATCH = 450;
      for (let i = 0; i < snap.docs.length; i += BATCH) {
        const batch = db.batch();
        for (const d of snap.docs.slice(i, i + BATCH)) batch.delete(d.ref);
        await batch.commit();
      }
      await ref.delete();
    },
  };
}
