import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Endre client factory so tests control what listProjects returns
// without touching the network or real credentials.
vi.mock("@/lib/endre/client", () => ({
  getEndreClient: vi.fn(),
}));

import { GET } from "@/app/api/admin/endre/projects/route";
import { getEndreClient } from "@/lib/endre/client";
import type { EndreClient } from "@/lib/endre/client";

const mGetEndreClient = vi.mocked(getEndreClient);
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
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  resetEndreEnv();
  delete process.env.ADMIN_UPLOAD_TOKEN;
});

function request(token?: string, query = "7100") {
  return new Request(
    `http://localhost/api/admin/endre/projects?query=${query}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
  );
}

function fakeClient(
  overrides: Partial<Record<keyof EndreClient, unknown>>,
): EndreClient {
  const reject = () => Promise.reject(new Error("unused in test"));
  return {
    listProjects: reject,
    getProject: reject,
    getProjectAmounts: reject,
    listProjectCases: reject,
    listProjectContracts: reject,
    getProjectTags: reject,
    listProjectOrganizations: reject,
    ...overrides,
  } as unknown as EndreClient;
}

describe("GET /api/admin/endre/projects — authorization", () => {
  it("returns 503 when ADMIN_UPLOAD_TOKEN is not configured", async () => {
    delete process.env.ADMIN_UPLOAD_TOKEN;
    const res = await GET(request(TOKEN));
    expect(res.status).toBe(503);
  });

  it("returns 401 without a valid admin token", async () => {
    const res = await GET(request("wrong-token"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/endre/projects — lookup", () => {
  it("returns sanitized matching projects with a count", async () => {
    mGetEndreClient.mockReturnValue(
      fakeClient({
        listProjects: () =>
          Promise.resolve([
            { id: "E-1", project_number: 7100, project_name: "Pilestredet" },
            { id: "E-2", project_number: 7200, project_name: "Skaidi" },
          ]),
      }),
    );

    const res = await GET(request(TOKEN, "7100"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.count).toBe(1);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].project_name).toBe("Pilestredet");
    // Internal ids are never exposed.
    expect(body.projects[0]).not.toHaveProperty("id");
  });

  it("never exposes ids, tokens, or secret-like fields", async () => {
    const SECRET = "tok_LIVE_SECRET_999";
    mGetEndreClient.mockReturnValue(
      fakeClient({
        listProjects: () =>
          Promise.resolve([
            { id: "E-1", project_number: 7100, access_token: SECRET },
          ]),
      }),
    );

    const res = await GET(request(TOKEN, "7100"));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("access_token");
    expect(text).not.toContain("E-1");
  });

  it("returns a safe generic error (no internals) when Endre throws", async () => {
    mGetEndreClient.mockReturnValue(
      fakeClient({
        listProjects: () =>
          Promise.reject(new Error("connection refused 10.0.0.5:443")),
      }),
    );

    const res = await GET(request(TOKEN, "7100"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(0);
    expect(typeof body.error).toBe("string");
    // The internal error message must not leak into the response.
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("reports state without calling Endre when the client is unavailable", async () => {
    mGetEndreClient.mockReturnValue(null);
    const res = await GET(request(TOKEN, "7100"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.projects).toEqual([]);
  });
});
