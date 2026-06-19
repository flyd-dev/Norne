/**
 * Generic agent tool tests: the tools expose RAW data (the model reasons over
 * it). Capacity sheets come from the REAL workbook; projects/accounts/documents
 * use mocked I/O. We assert the tools hand over the actual data + sources, not
 * that they compute domain answers (that is now the model's job).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { extractText } from "@/lib/documents/extract";
import { AGENT_TOOLS, type AgentDeps } from "@/lib/assistant/agent/agentTools";
import type { StoredStructuredTable } from "@/lib/documents/types";
import type { EndreClient } from "@/lib/endre/client";

const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;

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
    getBudgetLines: async () => [],
    getQuantities: async () => [],
    listDocuments: async () => [],
    searchDocuments: async () => [],
    endreClient: null,
    ...over,
  };
}

describe("generic agent tools", () => {
  it("read_staffing_sheets hands over the raw Kapasitetsanalyse rows + columns", async () => {
    const r = (await tool("read_staffing_sheets").execute({ sheet: "kapasitet" }, deps())) as {
      sources: string[];
      sheets: { sheet: string; columns: Record<string, string>; rows: { month: string; role: string | null; availableHours: number | null }[] }[];
    };
    const ka = r.sheets.find((s) => /kapasitetsanalyse/i.test(s.sheet))!;
    // The model sees the real column meanings and the actual rows.
    expect(ka.columns.availableHours).toBe("Teoretisk tilgjengelig 6/2");
    expect(ka.columns.role).toBe("Arbeidstype");
    const sep = ka.rows.find((x) => x.month === "2026-09" && x.role === "Steel fixer")!;
    expect(sep.availableHours).toBe(31.5);
    expect(r.sources).toContain("bemanningsplan_ai_demo_betong_2026.xlsx");
  });

  it("get_projects returns local full fields + endre list, with sources", async () => {
    const r = (await tool("get_projects").execute({}, deps({
      getProjects: async () => [{ id: "F", project_number: "7100", project_name: "Pilestredet", kontraktsverdi: 150705668 }],
      endreClient: endreClient([{ id: "E", project_number: 3025, project_name: "AFBO NORA" }]),
    }))) as { projects: Record<string, unknown>[]; sources: string[] };
    const local = r.projects.find((p) => p.project_number === "7100")!;
    expect(local.kontraktsverdi).toBe(150705668);
    expect(local.id).toBeUndefined(); // internal id stripped
    expect(r.projects.some((p) => p.project_number === "3025" && p.source === "endre")).toBe(true);
    expect(r.sources).toContain("Endre API: projects");
  });

  it("get_project exposes one project's fields with an honest source", async () => {
    const r = (await tool("get_project").execute({ project: "7100" }, deps({
      getProjects: async () => [{ id: "F", project_number: "7100", project_name: "Pilestredet", kontraktsverdi: 5 }],
    }))) as { found: boolean; source: string; fields: Record<string, unknown>; sources: string[] };
    expect(r.found).toBe(true);
    expect(r.source).toBe("firebase");
    expect(r.fields.kontraktsverdi).toBe(5);
    expect(r.sources).toEqual(["projects"]);
  });

  it("get_accounts returns the chart of accounts", async () => {
    const r = (await tool("get_accounts").execute({}, deps({
      getAccounts: async () => [{ id: "1", account_number: "6570", name: "Verneutstyr" }],
    }))) as { accounts: Record<string, unknown>[]; sources: string[] };
    expect(r.accounts[0].account_number).toBe("6570");
    expect(r.accounts[0].id).toBeUndefined();
    expect(r.sources).toEqual(["accounts"]);
  });

  it("get_budget_lines returns local-project budget rows (Firebase)", async () => {
    const r = (await tool("get_budget_lines").execute({ project: "7100" }, deps({
      getProjects: async () => [{ id: "F_7100", project_number: "7100", project_name: "Pilestredet" }],
      getBudgetLines: async () => [{ id: "b1", text: "Betong", amount: 1000 }],
    }))) as { found: boolean; rows: Record<string, unknown>[]; sources: string[] };
    expect(r.found).toBe(true);
    expect(r.rows[0].text).toBe("Betong");
    expect(r.rows[0].id).toBeUndefined();
    expect(r.sources).toEqual(["budgetLines"]);
  });

  it("get_budget_lines declines for an Endre-only project", async () => {
    const r = (await tool("get_budget_lines").execute({ project: "3025" }, deps({
      endreClient: endreClient([{ id: "E", project_number: 3025, project_name: "AFBO NORA" }]),
    }))) as { found: boolean; note?: string };
    expect(r.found).toBe(false);
    expect(r.note).toMatch(/lokale prosjekter/i);
  });

  it("list_sources orients the model over what exists", async () => {
    const r = (await tool("list_sources").execute({}, deps({
      getProjects: async () => [{ id: "F", project_number: "7100", project_name: "Pilestredet" }],
      listDocuments: async () => [{ name: "hms.pdf", fileType: "pdf" }],
    }))) as { projects: unknown[]; staffingSheets: { sheet: string }[]; documents: { name: string }[] };
    expect(r.documents[0].name).toBe("hms.pdf");
    expect(r.staffingSheets.some((s) => /kapasitetsanalyse/i.test(s.sheet))).toBe(true);
  });
});
