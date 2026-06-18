/**
 * Types and typed errors for the optional Endre API integration.
 *
 * Kept free of `import "server-only"` and of any secret values so it can be unit
 * tested directly. None of these errors ever carry tokens, passwords, or full
 * response bodies — only safe, human-readable context.
 */

/** Base class for every Endre integration error. */
export class EndreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndreError";
  }
}

/** The integration is disabled or required credentials are missing. */
export class EndreConfigError extends EndreError {
  constructor(message = "Endre-integrasjonen er ikke konfigurert.") {
    super(message);
    this.name = "EndreConfigError";
  }
}

/** Authentication against the Endre `/token` endpoint failed. */
export class EndreAuthError extends EndreError {
  /** HTTP status from the token endpoint, when available. */
  readonly status?: number;
  constructor(message = "Kunne ikke autentisere mot Endre API.", status?: number) {
    super(message);
    this.name = "EndreAuthError";
    this.status = status;
  }
}

/** A non-2xx response from a data endpoint (after a valid token). */
export class EndreApiError extends EndreError {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `Endre API svarte med status ${status}.`);
    this.name = "EndreApiError";
    this.status = status;
  }
}

/** A request exceeded the configured timeout and was aborted. */
export class EndreTimeoutError extends EndreError {
  constructor(message = "Forespørsel mot Endre API tidsavbrutt.") {
    super(message);
    this.name = "EndreTimeoutError";
  }
}

/** Successful response from `POST /token`. */
export interface EndreTokenResponse {
  access_token: string;
  token_type: string;
}

/**
 * Capabilities this client wraps. These map 1:1 to GET endpoints that actually
 * exist in the Endre OpenAPI document — we never advertise an endpoint that is
 * not in the spec. Used by the diagnostic endpoint.
 */
export const ENDRE_CAPABILITIES = [
  "organizations",
  "projects",
  "project_amounts",
  "project_cases",
  "project_contracts",
  "project_tags",
  "project_organizations",
] as const;

export type EndreCapability = (typeof ENDRE_CAPABILITIES)[number];

/** Options accepted by `listProjectCases` / `getCase`. */
export interface EndreCaseQuery {
  /**
   * Comma-separated includes. Valid values per the spec:
   * cost_items, tags, production_codes, invoices, external_references, relations.
   */
  include?: string;
}

/** Options accepted by `getProjectAmounts`. */
export interface EndreAmountsQuery {
  /** YYYY-MM-DD. */
  startDate?: string;
  /** YYYY-MM-DD. */
  endDate?: string;
  /** Filters by ChangeVersions.Type; repeated as ?case_types=1&case_types=2. */
  caseTypes?: number[];
}
