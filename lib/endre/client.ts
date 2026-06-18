/**
 * Optional, read-mostly client for the Endre public REST API.
 *
 * This is an *optional integration layer*. It is NOT wired into the chat answer
 * path: the existing Firebase / local-document flow is the source of truth. The
 * client only does anything when `ENDRE_API_ENABLED=true` and credentials are
 * present (see `endreReady()` in lib/env.ts).
 *
 * Auth: Endre uses an OAuth2 *password* grant. `POST /token` with form-encoded
 * `username`/`password` (+ optional `client_id`/`client_secret`) returns a JWT
 * bearer token. The token response does NOT include `expires_in`, so we read the
 * JWT `exp` claim when present and otherwise fall back to a conservative TTL.
 *
 * Safety rules enforced here:
 *   - NEVER log or embed passwords, client secrets, or tokens in errors/strings.
 *   - All requests time out (AbortController) and throw typed errors.
 *   - Only GET helpers for endpoints that actually exist in the OpenAPI spec.
 */

import "server-only";
import { endreReady, env } from "@/lib/env";
import {
  EndreApiError,
  EndreAuthError,
  EndreConfigError,
  EndreTimeoutError,
  type EndreAmountsQuery,
  type EndreCaseQuery,
  type EndreTokenResponse,
} from "@/lib/endre/types";

/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Fallback token lifetime used only when the JWT carries no `exp` claim. Kept
 * short and conservative so a stale token is re-fetched rather than trusted.
 */
const FALLBACK_TOKEN_TTL_MS = 30 * 60 * 1000;
/** Re-authenticate this long before the real expiry to avoid edge races. */
const EXPIRY_SKEW_MS = 60 * 1000;

export interface EndreClientConfig {
  baseUrl: string;
  username: string;
  password: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  /** Epoch ms at which we consider the token expired. */
  expiresAt: number;
}

/**
 * Decode the `exp` (seconds since epoch) claim from a JWT without verifying the
 * signature. Returns undefined if the token is not a parseable JWT. Never throws.
 */
function readJwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as { exp?: unknown };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
  } catch {
    // Not a JWT we can read — fall through to the TTL fallback.
  }
  return undefined;
}

export class EndreClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private cached: CachedToken | null = null;
  /** In-flight auth promise, so concurrent callers share one token request. */
  private pending: Promise<CachedToken> | null = null;

  constructor(config: EndreClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  /** Run a fetch with a timeout, translating aborts into EndreTimeoutError. */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new EndreTimeoutError();
      }
      // Network-level failure: surface a safe, generic message (no secrets).
      throw new EndreApiError(0, "Nettverksfeil mot Endre API.");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Authenticate against `/token` and cache the resulting bearer token. */
  private async authenticate(): Promise<CachedToken> {
    const body = new URLSearchParams();
    body.set("grant_type", "password");
    body.set("username", this.username);
    body.set("password", this.password);
    if (this.clientId) body.set("client_id", this.clientId);
    if (this.clientSecret) body.set("client_secret", this.clientSecret);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      // Never include the request body (it holds the password) in the error.
      throw new EndreAuthError(
        `Endre-autentisering feilet (status ${response.status}).`,
        response.status,
      );
    }

    let data: EndreTokenResponse;
    try {
      data = (await response.json()) as EndreTokenResponse;
    } catch {
      throw new EndreAuthError("Ugyldig svar fra Endre /token.");
    }
    if (!data.access_token) {
      throw new EndreAuthError("Endre /token svarte uten access_token.");
    }

    const expiresAt =
      readJwtExpiryMs(data.access_token) ?? this.now() + FALLBACK_TOKEN_TTL_MS;
    return {
      accessToken: data.access_token,
      tokenType: data.token_type || "Bearer",
      expiresAt,
    };
  }

  /** Return a valid cached token, authenticating/refreshing as needed. */
  private async getToken(force = false): Promise<CachedToken> {
    if (
      !force &&
      this.cached &&
      this.now() < this.cached.expiresAt - EXPIRY_SKEW_MS
    ) {
      return this.cached;
    }
    if (force) this.cached = null;
    if (!this.pending) {
      this.pending = this.authenticate()
        .then((token) => {
          this.cached = token;
          return token;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  /**
   * GET a JSON resource. Adds the bearer token, retries once on a 401 (token may
   * have been revoked early), and throws a typed error on failure.
   */
  async getJson<T = unknown>(
    path: string,
    query?: Record<string, string | number | (string | number)[] | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(path, query);

    const doRequest = async (force: boolean): Promise<Response> => {
      const token = await this.getToken(force);
      return this.fetchWithTimeout(url, {
        method: "GET",
        headers: {
          Authorization: `${token.tokenType} ${token.accessToken}`,
          Accept: "application/json",
        },
      });
    };

    let response = await doRequest(false);
    if (response.status === 401) {
      // Token may be stale/revoked — re-authenticate once and retry.
      response = await doRequest(true);
    }

    if (!response.ok) {
      throw new EndreApiError(
        response.status,
        `Endre API svarte med status ${response.status} for ${path}.`,
      );
    }

    return (await response.json()) as T;
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | (string | number)[] | undefined>,
  ): string {
    const url = new URL(
      path.startsWith("/") ? path : `/${path}`,
      `${this.baseUrl}/`,
    );
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /** Verify credentials by obtaining a token. Throws on failure. */
  async verifyAuth(): Promise<void> {
    await this.getToken(false);
  }

  // --- Read-only helpers (only endpoints present in the OpenAPI spec) -------

  /** GET /v1/organizations */
  listOrganizations<T = unknown>(): Promise<T> {
    return this.getJson<T>("/v1/organizations");
  }

  /** GET /v1/organizations/{organization_id} */
  getOrganization<T = unknown>(organizationId: string): Promise<T> {
    return this.getJson<T>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`,
    );
  }

  /** GET /v1/projects */
  listProjects<T = unknown>(): Promise<T> {
    return this.getJson<T>("/v1/projects");
  }

  /** GET /v1/projects/{project_id} */
  getProject<T = unknown>(projectId: string): Promise<T> {
    return this.getJson<T>(`/v1/projects/${encodeURIComponent(projectId)}`);
  }

  /** GET /v1/projects/{project_id}/amounts */
  getProjectAmounts<T = unknown>(
    projectId: string,
    query: EndreAmountsQuery = {},
  ): Promise<T> {
    return this.getJson<T>(
      `/v1/projects/${encodeURIComponent(projectId)}/amounts`,
      {
        start_date: query.startDate,
        end_date: query.endDate,
        case_types: query.caseTypes,
      },
    );
  }

  /** GET /v1/projects/{project_id}/cases */
  listProjectCases<T = unknown>(
    projectId: string,
    query: EndreCaseQuery = {},
  ): Promise<T> {
    return this.getJson<T>(
      `/v1/projects/${encodeURIComponent(projectId)}/cases`,
      { include: query.include },
    );
  }

  /** GET /v1/projects/{project_id}/contracts */
  listProjectContracts<T = unknown>(projectId: string): Promise<T> {
    return this.getJson<T>(
      `/v1/projects/${encodeURIComponent(projectId)}/contracts`,
    );
  }

  /** GET /v1/projects/{project_id}/tags */
  getProjectTags<T = unknown>(projectId: string): Promise<T> {
    return this.getJson<T>(
      `/v1/projects/${encodeURIComponent(projectId)}/tags`,
    );
  }

  /** GET /v1/projects/{project_id}/organizations */
  listProjectOrganizations<T = unknown>(projectId: string): Promise<T> {
    return this.getJson<T>(
      `/v1/projects/${encodeURIComponent(projectId)}/organizations`,
    );
  }
}

/**
 * Build a client from environment variables, or return null when the
 * integration is not ready (flag off or credentials missing). Callers should
 * treat null as "fall back to the existing Firebase/document flow".
 */
export function getEndreClient(): EndreClient | null {
  if (!endreReady()) return null;
  const username = env.endre.username();
  const password = env.endre.password();
  if (!username || !password) return null; // type-narrowing; endreReady covers this
  return new EndreClient({
    baseUrl: env.endre.baseUrl(),
    username,
    password,
    clientId: env.endre.clientId(),
    clientSecret: env.endre.clientSecret(),
  });
}

/** Like getEndreClient but throws a typed error instead of returning null. */
export function requireEndreClient(): EndreClient {
  const client = getEndreClient();
  if (!client) {
    throw new EndreConfigError(
      "Endre-integrasjonen er av eller mangler legitimasjon.",
    );
  }
  return client;
}
