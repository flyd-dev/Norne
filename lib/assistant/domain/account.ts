/** Canonical account (chart-of-accounts) domain model for the tool layer. */

export interface Account {
  accountNumber: string | null;
  name: string | null;
  /** Sanitized scalar fields, for ranking/matching. */
  fields: Record<string, unknown>;
}
