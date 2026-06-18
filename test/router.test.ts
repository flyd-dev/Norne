import { describe, expect, it } from "vitest";
import { detectIntent } from "@/lib/chat/intent";
import { routeMessage } from "@/lib/chat/router";

function route(message: string, followUp = false) {
  return routeMessage(message, detectIntent(message), followUp);
}

describe("routeMessage — account_lookup", () => {
  const d = route("Hva fører jeg arbeidshansker på?");
  it("routes account postings to account_lookup", () => {
    expect(d.route).toBe("account_lookup");
  });
  it("allows accounts, excludes projects and staffing plan", () => {
    expect(d.allowedSources).toContain("accounts");
    expect(d.excludedSources).toEqual(
      expect.arrayContaining(["projects", "staffingPlan"]),
    );
  });
  it("excludes the staffing plan from document search", () => {
    expect(d.excludeDocumentNames).toContain("bemanning");
  });
  it("never invents account numbers (format guardrail)", () => {
    expect(d.answerFormat).toMatch(/aldri finn på et kontonummer/i);
  });
});

describe("routeMessage — capacity", () => {
  const demand = route(
    "Vi starter nytt prosjekt i august. ca 29.000 timer. Fordeling 30% Stilfixer, 60% Carpenter og resterende welder. Har vi kapasitet?",
  );
  it("routes a demand question to staffing_capacity", () => {
    expect(demand.route).toBe("staffing_capacity");
  });
  it("uses the staffing plan and excludes accounts/projects", () => {
    expect(demand.allowedSources).toContain("staffingPlan");
    expect(demand.excludedSources).toEqual(
      expect.arrayContaining(["accounts", "projects"]),
    );
  });
  it("boosts bemanning, excludes the chart of accounts, pulls more chunks", () => {
    expect(demand.boostDocumentNames).toContain("bemanning");
    expect(demand.excludeDocumentNames).toContain("kontoplan");
    expect(demand.maxChunks).toBe(16);
  });

  it("routes a per-month question to monthly_capacity", () => {
    const m = route("Kan du gi meg tilgjengelig kapasitet hver måned ut året?");
    expect(m.route).toBe("monthly_capacity");
    expect(m.excludedSources).toEqual(
      expect.arrayContaining(["accounts", "projects"]),
    );
  });
});

describe("routeMessage — project / budget / quantities", () => {
  it("routes a summary to project_summary and keeps the staffing plan out", () => {
    const d = route("Oppsummer prosjekt 7100");
    expect(d.route).toBe("project_summary");
    expect(d.excludedSources).toContain("staffingPlan");
    expect(d.excludeDocumentNames).toContain("bemanning");
  });

  it("routes budget questions to budget_lines", () => {
    const d = route("Hvilke budsjettlinjer finnes på prosjekt 7100?");
    expect(d.route).toBe("budget_lines");
    expect(d.allowedSources).toContain("budgetLines");
    expect(d.excludedSources).toContain("accounts");
  });

  it("routes quantity questions to quantities", () => {
    const d = route("Hvilke mengder finnes på prosjekt 7100?");
    expect(d.route).toBe("quantities");
    expect(d.allowedSources).toContain("quantities");
  });
});

describe("routeMessage — follow-up flag", () => {
  it("carries the follow-up flag through", () => {
    const d = route("Oppsummer prosjekt 7100", true);
    expect(d.resolvedFromFollowUp).toBe(true);
  });
});
