/**
 * Tool-level tests for the project + account + document tools, with the
 * contract-value honesty rule (plan point 7) pinned: a project WITHOUT a
 * contract-value field must NOT report one — it returns coverage "partial" and
 * points at the amount fields instead.
 */

import { describe, expect, it } from "vitest";
import {
  getProjectMetric,
  getProjectSummary,
  getProjectList,
  compareProjects,
} from "@/lib/assistant/tools/projects";
import { searchChartOfAccounts, getAccountForPurchase } from "@/lib/assistant/tools/accounts";
import { searchUploadedDocuments } from "@/lib/assistant/tools/documents";
import { askClarifyingQuestion } from "@/lib/assistant/tools/clarify";
import type { ToolContext } from "@/lib/assistant/tools/registry";

const REF = { projectNumber: "7100", projectName: "Pilestredet" };

describe("getProjectMetric — contract-value honesty", () => {
  it("reports the value when a real contract-value field exists", async () => {
    const ctx: ToolContext = {
      projectRecord: { project_number: "7100", kontraktsverdi: 150705668 },
      projectRef: REF,
      projectSources: ["Endre API: projects"],
    };
    const r = await getProjectMetric.run({ metric: "contract_value" }, ctx);
    expect(r.coverage).toBe("full");
    expect(r.data!.value).toBe(150705668);
  });

  it("does NOT invent a contract value from generic amounts", async () => {
    const ctx: ToolContext = {
      projectRecord: {
        project_number: "7100",
        amounts: { count: 3, totals: { accepted: 999 } },
      },
      projectRef: REF,
      projectSources: ["Endre API: projects", "Endre API: project_amounts"],
    };
    const r = await getProjectMetric.run({ metric: "contract_value" }, ctx);
    expect(r.coverage).toBe("partial");
    expect(r.data!.value).toBeNull();
    expect(r.note).toMatch(/ikke et eget kontraktsverdi-felt/i);
    expect(r.note).toContain("amounts");
  });

  it("returns coverage none when no project was resolved", async () => {
    const r = await getProjectMetric.run({ metric: "result" }, {});
    expect(r.coverage).toBe("none");
  });

  it("validates that a metric is required", () => {
    expect(getProjectMetric.validate({}).ok).toBe(false);
    expect(getProjectMetric.validate({ metric: "result" }).ok).toBe(true);
  });
});

describe("getProjectSummary / getProjectList", () => {
  it("summary echoes the resolved record", async () => {
    const ctx: ToolContext = { projectRecord: { project_number: "7100" }, projectSources: ["projects"] };
    const r = await getProjectSummary.run({}, ctx);
    expect(r.coverage).toBe("full");
    expect(r.data).toEqual({ project_number: "7100" });
  });

  it("list returns none when empty, full when populated", async () => {
    expect((await getProjectList.run({}, {})).coverage).toBe("none");
    const r = await getProjectList.run({}, {
      projectList: [{ projectNumber: "7100", projectName: "Pilestredet" }],
    });
    expect(r.coverage).toBe("full");
    expect(r.data!.length).toBe(1);
  });
});

describe("compareProjects", () => {
  it("normalizes each project with its own source, no conflation", async () => {
    const r = await compareProjects.run(
      {
        projects: [
          { record: { project_number: "7100", project_name: "Pilestredet", kontraktsverdi: 150705668 }, source: "firebase" },
          { record: { project_number: 3025, project_name: "AFBO NORA", amounts: { totals: { TotalAmount: 22938804 } } }, source: "endre" },
        ],
      },
      {},
    );
    expect(r.coverage).toBe("full");
    expect(r.data).toHaveLength(2);
    expect(r.data![0]).toMatchObject({ projectNumber: "7100", source: "firebase" });
    expect(r.data![1]).toMatchObject({ projectNumber: "3025", source: "endre" });
    // 3025 (Endre) carries no contract-value field — never invented.
    expect(r.data![1].fields.kontraktsverdi).toBeUndefined();
  });

  it("is partial when some referenced projects were not found", async () => {
    const r = await compareProjects.run(
      { projects: [{ record: { project_number: "7100" }, source: "firebase" }], missing: ["9999"] },
      {},
    );
    expect(r.coverage).toBe("partial");
    expect(r.note).toContain("9999");
  });

  it("is none when nothing was found", async () => {
    const r = await compareProjects.run({ projects: [], missing: ["1", "2"] }, {});
    expect(r.coverage).toBe("none");
  });
});

describe("account tools", () => {
  const accounts = [
    { id: "1", account_number: "6940", name: "Verneutstyr og arbeidsklær" },
    { id: "2", account_number: "4000", name: "Varekjøp" },
  ];

  it("ranks the matching account for a purchase", async () => {
    const r = await getAccountForPurchase.run(
      { query: "arbeidshansker" },
      { accounts },
    );
    expect(r.coverage).toBe("full");
    expect(r.data![0].account.account_number).toBe("6940");
  });

  it("searchChartOfAccounts returns none when nothing matches", async () => {
    const r = await searchChartOfAccounts.run({ query: "flybilletter" }, { accounts });
    expect(r.coverage).toBe("none");
  });

  it("returns none when no chart is loaded", async () => {
    const r = await searchChartOfAccounts.run({ query: "varekjøp" }, {});
    expect(r.coverage).toBe("none");
  });
});

describe("document + clarify tools", () => {
  it("searchUploadedDocuments filters by document name", async () => {
    const ctx: ToolContext = {
      documentMatches: [
        { documentName: "hms.pdf", sheetName: null, chunkIndex: 0, text: "verneutstyr", documentId: "a", fileType: "pdf", score: 1 },
        { documentName: "plan.xlsx", sheetName: "Ark1", chunkIndex: 0, text: "timer", documentId: "b", fileType: "xlsx", score: 1 },
      ] as ToolContext["documentMatches"],
    };
    const r = await searchUploadedDocuments.run({ query: "verneutstyr", document: "hms" }, ctx);
    expect(r.coverage).toBe("full");
    expect(r.data!.length).toBe(1);
    expect(r.data![0].documentName).toBe("hms.pdf");
  });

  it("askClarifyingQuestion returns the structured clarification", async () => {
    const r = await askClarifyingQuestion.run(
      { reason: "vagt", options: ["prosjektdata", "bemanning"] },
      {},
    );
    expect(r.coverage).toBe("full");
    expect(r.data!.options).toEqual(["prosjektdata", "bemanning"]);
  });
});
