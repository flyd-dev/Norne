/** Domain types for the Firestore data we read. */

/** A generic Firestore document: an id plus arbitrary fields. */
export interface FirestoreDoc {
  id: string;
  [key: string]: unknown;
}

export interface Account extends FirestoreDoc {}
export interface Project extends FirestoreDoc {}
export interface BudgetLine extends FirestoreDoc {}
export interface Quantity extends FirestoreDoc {}

/**
 * Minimal read-only Firestore interface.
 *
 * Both the Admin SDK backend and the REST backend implement this, so the
 * service layer and orchestrator never need to know which one is in use.
 */
export interface FirestoreClient {
  /**
   * Read documents from a top-level collection.
   * @param limit optional cap on the number of documents fetched (no cap if omitted).
   */
  listCollection(collection: string, limit?: number): Promise<FirestoreDoc[]>;

  /** Read a single document by id from a top-level collection. */
  getDocument(collection: string, id: string): Promise<FirestoreDoc | null>;

  /** Read every document in a subcollection of a parent document. */
  listSubcollection(
    parentCollection: string,
    parentId: string,
    subcollection: string,
  ): Promise<FirestoreDoc[]>;

  /** Create or overwrite a single top-level document. */
  createDocument(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void>;

  /** Create multiple documents in a subcollection (batched where possible). */
  createSubDocuments(
    parentCollection: string,
    parentId: string,
    subcollection: string,
    items: { id: string; data: Record<string, unknown> }[],
  ): Promise<void>;

  /** Delete a document and all docs in one of its subcollections. */
  deleteDocumentWithSubcollection(
    collection: string,
    id: string,
    subcollection: string,
  ): Promise<void>;
}
