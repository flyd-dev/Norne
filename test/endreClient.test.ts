import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EndreClient } from "@/lib/endre/client";
import {
  EndreApiError,
  EndreAuthError,
  EndreTimeoutError,
} from "@/lib/endre/types";

const USERNAME = "test-api-user";
const PASSWORD = "super-secret-password";
const TOKEN = "header.payload.signature"; // opaque, non-JWT -> uses TTL fallback

/** A minimal Response-like object for the mock fetch. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function baseConfig(fetchImpl: typeof fetch, now = () => 1_000) {
  return {
    baseUrl: "https://public-api.endre.app",
    username: USERNAME,
    password: PASSWORD,
    fetchImpl,
    now,
  };
}

describe("EndreClient — authentication", () => {
  it("sends a password grant to /token and uses the bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/token")) {
        return jsonResponse(200, { access_token: TOKEN, token_type: "bearer" });
      }
      return jsonResponse(200, [{ id: "p1" }]);
    }) as unknown as typeof fetch;

    const client = new EndreClient(baseConfig(fetchImpl));
    const projects = await client.listProjects<{ id: string }[]>();

    expect(projects).toEqual([{ id: "p1" }]);
    // First call is the token request, form-encoded with grant_type=password.
    expect(calls[0].url).toBe("https://public-api.endre.app/token");
    const body = String(calls[0].init.body);
    expect(body).toContain("grant_type=password");
    expect(body).toContain(`username=${USERNAME}`);
    // Second call carries the bearer token.
    expect(calls[1].url).toBe("https://public-api.endre.app/v1/projects");
    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`bearer ${TOKEN}`);
  });

  it("throws a typed EndreAuthError on a failed token request", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { detail: "bad creds" }),
    ) as unknown as typeof fetch;
    const client = new EndreClient(baseConfig(fetchImpl));
    await expect(client.listProjects()).rejects.toBeInstanceOf(EndreAuthError);
  });
});

describe("EndreClient — never leaks secrets", () => {
  it("does not log to the console during auth or requests", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/token")
        ? jsonResponse(200, { access_token: TOKEN, token_type: "bearer" })
        : jsonResponse(200, {}),
    ) as unknown as typeof fetch;

    const client = new EndreClient(baseConfig(fetchImpl));
    await client.getProject("123");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("never includes the password or token in error messages", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { detail: "denied" }),
    ) as unknown as typeof fetch;
    const client = new EndreClient(baseConfig(fetchImpl));
    try {
      await client.listProjects();
      throw new Error("expected to throw");
    } catch (error) {
      const text = `${(error as Error).name}: ${(error as Error).message}`;
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(TOKEN);
    }
  });
});

describe("EndreClient — token caching & refresh", () => {
  it("authenticates once and reuses the token for subsequent calls", async () => {
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/token")) {
        tokenCalls += 1;
        return jsonResponse(200, { access_token: TOKEN, token_type: "bearer" });
      }
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    const client = new EndreClient(baseConfig(fetchImpl));
    await client.listProjects();
    await client.getProject("a");
    await client.listOrganizations();

    expect(tokenCalls).toBe(1);
  });

  it("re-authenticates after a 401 and retries the request once", async () => {
    let tokenCalls = 0;
    let dataCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/token")) {
        tokenCalls += 1;
        return jsonResponse(200, { access_token: TOKEN, token_type: "bearer" });
      }
      dataCalls += 1;
      // First data call: token rejected. Second: succeeds.
      return dataCalls === 1
        ? jsonResponse(401, {})
        : jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    const client = new EndreClient(baseConfig(fetchImpl));
    const result = await client.listProjects<{ ok: boolean }>();

    expect(result).toEqual({ ok: true });
    expect(tokenCalls).toBe(2); // initial + forced refresh
    expect(dataCalls).toBe(2);
  });

  it("re-authenticates after the cached token expires (TTL fallback)", async () => {
    let tokenCalls = 0;
    let clock = 1_000;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/token")) {
        tokenCalls += 1;
        return jsonResponse(200, { access_token: TOKEN, token_type: "bearer" });
      }
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    const client = new EndreClient(baseConfig(fetchImpl, () => clock));
    await client.listProjects();
    // Advance past the 30-minute fallback TTL.
    clock += 31 * 60 * 1000;
    await client.listProjects();

    expect(tokenCalls).toBe(2);
  });
});

describe("EndreClient — errors & timeouts", () => {
  it("throws EndreApiError with the status on a non-2xx data response", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/token")
        ? jsonResponse(200, { access_token: TOKEN, token_type: "bearer" })
        : jsonResponse(500, {}),
    ) as unknown as typeof fetch;
    const client = new EndreClient(baseConfig(fetchImpl));
    await expect(client.listProjects()).rejects.toMatchObject({
      name: "EndreApiError",
      status: 500,
    });
    await expect(client.listProjects()).rejects.toBeInstanceOf(EndreApiError);
  });

  it("aborts and throws EndreTimeoutError when a request exceeds the timeout", async () => {
    // fetch that never resolves until its signal aborts.
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            ),
          );
        }),
    ) as unknown as typeof fetch;

    const client = new EndreClient({
      ...baseConfig(fetchImpl),
      timeoutMs: 10,
    });
    await expect(client.listProjects()).rejects.toBeInstanceOf(
      EndreTimeoutError,
    );
  });
});

describe("EndreClient — query building", () => {
  it("repeats array params and encodes amounts query", async () => {
    let dataUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/token")) {
        return jsonResponse(200, { access_token: TOKEN, token_type: "bearer" });
      }
      dataUrl = url;
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    const client = new EndreClient(baseConfig(fetchImpl));
    await client.getProjectAmounts("proj 1", {
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      caseTypes: [1, 2],
    });

    expect(dataUrl).toContain("/v1/projects/proj%201/amounts");
    expect(dataUrl).toContain("start_date=2026-01-01");
    expect(dataUrl).toContain("end_date=2026-06-30");
    expect(dataUrl).toContain("case_types=1");
    expect(dataUrl).toContain("case_types=2");
  });
});
