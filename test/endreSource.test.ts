import { describe, expect, it, vi } from "vitest";
import {
  buildEndreProjectContext,
  findEndreProjects,
  type EndreDiagnostics,
} from "@/lib/chat/endreSource";
import type { EndreClient } from "@/lib/endre/client";

function freshDiag(): EndreDiagnostics {
  return {
    projectQuery: null,
    attemptedEndre: false,
    endreFound: false,
    fallbackReason: null,
  };
}

/**
 * A configurable fake EndreClient. Only the methods buildEndreProjectContext
 * uses are implemented; each can be told to resolve with data or to throw.
 */
function fakeClient(overrides: Partial<Record<keyof EndreClient, unknown>>) {
  const reject = () => Promise.reject(new Error("not configured in this test"));
  const base = {
    listProjects: reject,
    getProject: reject,
    getProjectAmounts: reject,
    listProjectCases: reject,
    listProjectContracts: reject,
    getProjectTags: reject,
    listProjectOrganizations: reject,
  };
  return { ...base, ...overrides } as unknown as EndreClient;
}

const PROJECTS = [
  { id: "P-1", project_number: 7100, project_name: "Pilestredet" },
  { id: "P-2", project_number: 7200, project_name: "Skaidi" },
];

describe("buildEndreProjectContext — project summary", () => {
  it("uses Endre for 'Oppsummer prosjekt 7100' and marks every source used", async () => {
    const client = fakeClient({
      listProjects: () => Promise.resolve(PROJECTS),
      getProject: () =>
        Promise.resolve({ id: "P-1", project_name: "Pilestredet", status: "Aktiv" }),
      getProjectAmounts: () =>
        Promise.resolve([{ amount: 1000 }, { amount: 500 }]),
      listProjectCases: () => Promise.resolve([{ id: "c1" }, { id: "c2" }]),
      listProjectContracts: () => Promise.resolve([{ value: 250 }]),
      getProjectTags: () => Promise.resolve([{ name: "Rehab" }]),
      listProjectOrganizations: () => Promise.resolve([{ name: "Norne AS" }]),
    });

    const result = await buildEndreProjectContext("Oppsummer prosjekt 7100", client);
    expect(result).not.toBeNull();

    // Source labels are clearly marked, one per capability actually used.
    expect(result!.sources).toEqual([
      "Endre API: projects",
      "Endre API: project_amounts",
      "Endre API: project_cases",
      "Endre API: project_contracts",
      "Endre API: project_tags",
      "Endre API: project_organizations",
    ]);

    const summary = result!.context.endre_project as Record<string, unknown>;
    expect(summary.project_name).toBe("Pilestredet");
    expect(summary.status).toBe("Aktiv");
    // Rows are aggregated (count + totals), never passed through raw.
    expect(summary.amounts).toMatchObject({ count: 2, totals: { amount: 1500 } });
    expect(summary.cases).toMatchObject({ count: 2 });
    expect(summary.contracts).toMatchObject({ count: 1, totals: { value: 250 } });
    expect(summary.tags).toMatchObject({ items: ["Rehab"] });
    expect(summary.organizations).toMatchObject({ items: ["Norne AS"] });
  });

  it("includes whichever sub-endpoints succeed and skips ones that fail", async () => {
    const client = fakeClient({
      listProjects: () => Promise.resolve(PROJECTS),
      getProject: () => Promise.resolve({ id: "P-1", project_name: "Pilestredet" }),
      getProjectAmounts: () => Promise.resolve([{ amount: 10 }]),
      // cases/contracts/tags/orgs all throw → omitted, but summary still returns.
    });

    const result = await buildEndreProjectContext("oppsummer 7100", client);
    expect(result).not.toBeNull();
    expect(result!.sources).toEqual([
      "Endre API: projects",
      "Endre API: project_amounts",
    ]);
    const summary = result!.context.endre_project as Record<string, unknown>;
    expect(summary.amounts).toMatchObject({ count: 1 });
    expect(summary.cases).toBeUndefined();
  });
});

describe("buildEndreProjectContext — project list", () => {
  it("returns the sanitized Endre project list for a general question", async () => {
    const client = fakeClient({
      listProjects: () => Promise.resolve(PROJECTS),
    });
    const result = await buildEndreProjectContext("Hvilke prosjekter finnes?", client);
    expect(result).not.toBeNull();
    expect(result!.sources).toEqual(["Endre API: projects"]);
    const list = result!.context.endre_projects as Record<string, unknown>[];
    expect(list).toHaveLength(2);
    // Internal ids are dropped; names/numbers remain.
    expect(list[0]).not.toHaveProperty("id");
    expect(list[0].project_name).toBe("Pilestredet");
  });
});

describe("buildEndreProjectContext — fallback behaviour", () => {
  it("returns null when listProjects fails (caller falls back to Firebase)", async () => {
    const client = fakeClient({
      listProjects: () => Promise.reject(new Error("boom")),
    });
    const result = await buildEndreProjectContext("Oppsummer prosjekt 7100", client);
    expect(result).toBeNull();
  });

  it("returns null when a specific project is named but not present in Endre", async () => {
    const client = fakeClient({
      listProjects: () => Promise.resolve(PROJECTS),
    });
    // 9999 is not in Endre, and the question names a specific project → fall back.
    const result = await buildEndreProjectContext("Oppsummer prosjekt 9999", client);
    expect(result).toBeNull();
  });

  it("returns null when Endre has no usable projects", async () => {
    const client = fakeClient({ listProjects: () => Promise.resolve([]) });
    const result = await buildEndreProjectContext("Hvilke prosjekter finnes?", client);
    expect(result).toBeNull();
  });
});

describe("buildEndreProjectContext — diagnostics", () => {
  it("records attemptedEndre + endreFound + projectQuery when Endre answers", async () => {
    const client = fakeClient({
      listProjects: () => Promise.resolve(PROJECTS),
      getProject: () => Promise.resolve({ id: "P-1", project_name: "Pilestredet" }),
    });
    const diag = freshDiag();
    await buildEndreProjectContext("Oppsummer prosjekt 7100", client, diag);
    expect(diag.attemptedEndre).toBe(true);
    expect(diag.endreFound).toBe(true);
    expect(diag.projectQuery).toBe("7100");
    expect(diag.fallbackReason).toBeNull();
  });

  it("flags project_not_found_in_endre when a named project is missing", async () => {
    const client = fakeClient({ listProjects: () => Promise.resolve(PROJECTS) });
    const diag = freshDiag();
    const result = await buildEndreProjectContext(
      "Oppsummer prosjekt 9999",
      client,
      diag,
    );
    expect(result).toBeNull();
    expect(diag.attemptedEndre).toBe(true);
    expect(diag.endreFound).toBe(false);
    expect(diag.fallbackReason).toBe("project_not_found_in_endre");
  });

  it("flags endre_list_unavailable when listProjects fails", async () => {
    const client = fakeClient({
      listProjects: () => Promise.reject(new Error("down")),
    });
    const diag = freshDiag();
    await buildEndreProjectContext("Oppsummer prosjekt 7100", client, diag);
    expect(diag.fallbackReason).toBe("endre_list_unavailable");
  });

  it("resolves a project whose number lives under a non-standard field name", async () => {
    // Endre returns the number under `projectNo` — NOT in PROJECT_NAME_FIELDS.
    const client = fakeClient({
      listProjects: () =>
        Promise.resolve([{ id: "P-9", projectNo: 7100, label: "Pilestredet" }]),
      getProject: () => Promise.resolve({ id: "P-9", label: "Pilestredet" }),
    });
    const diag = freshDiag();
    const result = await buildEndreProjectContext(
      "Oppsummer prosjekt 7100",
      client,
      diag,
    );
    expect(result).not.toBeNull();
    expect(diag.endreFound).toBe(true);
    expect(result!.sources).toContain("Endre API: projects");
  });
});

describe("findEndreProjects — admin debug lookup", () => {
  it("returns sanitized matches and counts, never ids or secrets", () => {
    const raw = [
      { id: "E-1", project_number: 7100, project_name: "Pilestredet", token: "x" },
      { id: "E-2", project_number: 7200, project_name: "Skaidi" },
    ];
    const result = findEndreProjects(raw, "7100");
    expect(result.total).toBe(2);
    expect(result.count).toBe(1);
    expect(result.projects[0].project_name).toBe("Pilestredet");
    expect(result.projects[0]).not.toHaveProperty("id");
    expect(result.projects[0]).not.toHaveProperty("token");
  });

  it("returns all projects when the query is empty", () => {
    const raw = [{ id: "E-1", project_number: 7100 }];
    const result = findEndreProjects(raw, "");
    expect(result.total).toBe(1);
    expect(result.count).toBe(1);
  });

  it("matches across any scalar field (e.g. a name substring)", () => {
    const raw = [{ id: "E-1", project_number: 7100, project_name: "Pilestredet" }];
    expect(findEndreProjects(raw, "pile").count).toBe(1);
    expect(findEndreProjects(raw, "nope").count).toBe(0);
  });
});

describe("buildEndreProjectContext — never leaks secrets or raw payloads", () => {
  it("strips secret-looking fields and does not log them", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const SECRET = "tok_LIVE_SUPERSECRET_12345";

    const client = fakeClient({
      listProjects: () =>
        Promise.resolve([{ id: "P-1", project_number: 7100, access_token: SECRET }]),
      getProject: () =>
        Promise.resolve({ id: "P-1", project_name: "Pilestredet", api_key: SECRET }),
      getProjectAmounts: () => Promise.resolve([{ amount: 1, password: SECRET }]),
    });

    const result = await buildEndreProjectContext("Oppsummer prosjekt 7100", client);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("password");

    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(" ");
    expect(logged).toBe("");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
