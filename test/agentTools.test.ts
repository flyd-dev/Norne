/**
 * Agent tool tests: capacity against the REAL workbook, project/account/document
 * tools with mocked I/O. Confirms the agent tools delegate to the deterministic
 * tools (September included, persons→hours estimate, source isolation, honesty).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { extractText } from "@/lib/documents/extract";
import { AGENT_TOOLS, type AgentDeps } from "@/lib/assistant/agent/agentTools";
import type { StoredStructuredTable } from "@/lib/documents/types";
import type { EndreClient } from "@/lib/endre/client";

const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;

// Load the real workbook's structured tables once.
let cached: StoredStructuredTable[] | null = null;
async function loadRealTables(): Promise<StoredStructuredTable[]> {
  if (cached) return cached;
  const content = await extractText(
    fs.readFileSync("data/bemanningsplan_ai_demo_betong_2026.xlsx"),
    "bemanningsplan_ai_demo_betong_2026.xlsx",
  );
  cached = (content.structured ?? []).map((t) => ({
    ...t,
    documentId: "D1",
    documentName: "bemanningsplan_ai_demo_betong_2026.xlsx",
  }));
  return cached;
}

function endreClient(projects: unknown[]): EndreClient {
  const reject = () => Promise.reject(new Error("unused"));
  return {
    listProjects: () => Promise.resolve(projects),
    getProject: reject,
    getProjectAmounts: () => Promise.resolve([{ TotalAmount: 22938804.4 }]),
    listProjectCases: reject,
    listProjectContracts: reject,
    getProjectTags: reject,
    listProjectOrganizations: reject,
  } as unknown as EndreClient;
}

function deps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    getStructuredTables: loadRealTables,
    getProjects: async () => [],
    getAccounts: async () => [],
    searchDocuments: async () => [],
    endreClient: null,
    ...over,
  };
}

describe("agent tools — capacity (real workbook)", () => {
  it("get_monthly_capacity includes September with per-fag values", async () => {
    const r = (await tool("get_monthly_capacity").execute(
      { until_month: "2026-09" },
      deps(),
    )) as { coverage: string; data: { months: { month: string; byRole: Record<string, number> }[] } };
    expect(r.coverage).toBe("full");
    expect(r.data.months.map((m) => m.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(r.data.months[2].byRole["Steel fixer"]).toBe(31.5);
  });

  it("get_available_hours_for_month converts august persons to hours", async () => {
    const r = (await tool("get_available_hours_for_month").execute(
      { month: "august" },
      deps(),
    )) as { found: boolean; month: string; availableHours: Record<string, number>; estimate: boolean };
    expect(r.found).toBe(true);
    expect(r.month).toBe("2026-08");
    expect(r.estimate).toBe(true);
    expect(r.availableHours["Carpenter"]).toBeCloseTo(12022.4, 1);
  });
});

describe("agent tools — projects / accounts / documents (mocked)", () => {
  it("get_project resolves a Firestore project and exposes its fields", async () => {
    const r = (await tool("get_project").execute(
      { project: "7100" },
      deps({ getProjects: async () => [{ id: "F", project_number: "7100", project_name: "Pilestredet", kontraktsverdi: 150705668 }] }),
    )) as { found: boolean; source: string; fields: Record<string, unknown> };
    expect(r.found).toBe(true);
    expect(r.source).toBe("firebase");
    expect(r.fields.kontraktsverdi).toBe(150705668);
  });

  it("compare_projects keeps each project on its own source", async () => {
    const r = (await tool("compare_projects").execute(
      { projects: ["7100", "3025"] },
      deps({
        getProjects: async () => [{ id: "F", project_number: "7100", project_name: "Pilestredet" }],
        endreClient: endreClient([{ id: "E", project_number: 3025, project_name: "AFBO NORA" }]),
      }),
    )) as { coverage: string; data: { projectNumber: string; source: string }[] };
    // Endre is tried first, so 7100 (not in Endre) falls to Firestore, 3025 → Endre.
    const sources = Object.fromEntries(r.data.map((p) => [p.projectNumber, p.source]));
    expect(sources["3025"]).toBe("endre");
    expect(sources["7100"]).toBe("firebase");
  });

  it("search_chart_of_accounts ranks a matching account", async () => {
    const r = (await tool("search_chart_of_accounts").execute(
      { query: "arbeidshansker" },
      deps({ getAccounts: async () => [{ id: "1", account_number: "6570", name: "Verneutstyr" }] }),
    )) as { coverage: string; accounts: { account_number: string }[] };
    expect(r.coverage).toBe("full");
    expect(r.accounts[0].account_number).toBe("6570");
  });

  it("search_documents returns matching chunks", async () => {
    const r = (await tool("search_documents").execute(
      { query: "verneutstyr" },
      deps({
        searchDocuments: async () => [
          { documentId: "a", documentName: "hms.pdf", fileType: "pdf", sheetName: null, chunkIndex: 0, score: 1, text: "verneutstyr" } as never,
        ],
      }),
    )) as { coverage: string; data: { documentName: string }[] };
    expect(r.coverage).toBe("full");
    expect(r.data[0].documentName).toBe("hms.pdf");
  });
});
