import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/endre/status/route";

const TOKEN = "test-admin-token";

let errSpy: ReturnType<typeof vi.spyOn>;

function resetEndreEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ENDRE_")) delete process.env[key];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEndreEnv();
  process.env.ADMIN_UPLOAD_TOKEN = TOKEN;
  // Silence the safe error logging on the (unused) auth-failure path.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  resetEndreEnv();
  delete process.env.ADMIN_UPLOAD_TOKEN;
});

function request(token?: string) {
  return new Request("http://localhost/api/admin/endre/status", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("GET /api/admin/endre/status — authorization", () => {
  it("returns 503 when ADMIN_UPLOAD_TOKEN is not configured", async () => {
    delete process.env.ADMIN_UPLOAD_TOKEN;
    const res = await GET(request(TOKEN));
    expect(res.status).toBe(503);
  });

  it("returns 401 without a valid admin token", async () => {
    const res = await GET(request("wrong-token"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when no authorization header is sent", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/endre/status — integration state", () => {
  it("reports enabled=false when the feature flag is off", async () => {
    process.env.ENDRE_API_ENABLED = "false";
    process.env.ENDRE_API_USERNAME = "u";
    process.env.ENDRE_API_PASSWORD = "p";
    const res = await GET(request(TOKEN));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.configured).toBe(true);
    expect(body.canAuthenticate).toBe(false);
    expect(body.availableCapabilities).toEqual([]);
  });

  it("reports configured=false when credentials are missing", async () => {
    process.env.ENDRE_API_ENABLED = "true";
    const res = await GET(request(TOKEN));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.configured).toBe(false);
    expect(body.canAuthenticate).toBe(false);
    // No live call is attempted, so no capabilities are advertised.
    expect(body.availableCapabilities).toEqual([]);
  });

  it("never includes credentials in the response body", async () => {
    process.env.ENDRE_API_ENABLED = "false";
    process.env.ENDRE_API_USERNAME = "secret-user";
    process.env.ENDRE_API_PASSWORD = "secret-pass";
    const res = await GET(request(TOKEN));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("secret-user");
    expect(text).not.toContain("secret-pass");
  });
});
