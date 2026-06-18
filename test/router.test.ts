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

  // A time-bound follow-up after a capacity turn: the combined retrieval text
  // carries the demand, while the *new* message asks for a monthly view. It must
  // upgrade to monthly_capacity (not stay on staffing_capacity).
  it("upgrades a 'frem til <måned>' follow-up to monthly_capacity", () => {
    const retrieval =
      "Vi starter nytt prosjekt i august. ca 29.000 timer. Fordeling 30% " +
      "Stilfixer, 60% Carpenter og resterende welder. Har vi kapasitet? " +
      "Gi meg det du har frem til september 2026";
    const d = routeMessage(retrieval, detectIntent(retrieval), true, "Gi meg det du har frem til september 2026");
    expect(d.route).toBe("monthly_capacity");
  });

  // Even a bare month/year in the new message flips it, once a capacity
  // discussion is underway (lighter signal applied only to the new message).
  it("upgrades a bare-month follow-up to monthly_capacity", () => {
    const retrieval =
      "Vi starter nytt prosjekt i august. ca 29.000 timer. 60% Carpenter. " +
      "Har vi kapasitet? Tallene for september 2026";
    const d = routeMessage(retrieval, detectIntent(retrieval), true, "Tallene for september 2026");
    expect(d.route).toBe("monthly_capacity");
  });

  // The lighter signal must NOT come from the inherited prior question: a fresh,
  // self-contained demand that merely mentions a start month stays staffing.
  it("keeps a self-contained demand mentioning a start month on staffing_capacity", () => {
    const d = route(
      "Vi starter nytt prosjekt i august. ca 29.000 timer. Fordeling 60% " +
        "Carpenter og resten welder. Har vi kapasitet?",
    );
    expect(d.route).toBe("staffing_capacity");
  });

  // A capacity question with NO quantified demand must not ask the model to
  // produce a behov/differanse analysis or to conclude capacity sufficiency.
  it("uses a no-demand answer format when no hours/role split is stated", () => {
    const d = route("Hva er tilgjengelig kapasitet?");
    expect(d.route).toBe("staffing_capacity");
    expect(d.answerFormat).toMatch(/IKKE oppgitt et konkret behov/i);
    expect(d.answerFormat).toMatch(/Differanse: 0/);
  });

  // The monthly route with no demand must also forbid an unfounded conclusion.
  it("forbids an unfounded conclusion on a no-demand monthly view", () => {
    const d = route("Gi meg tilgjengelig kapasitet per måned");
    expect(d.route).toBe("monthly_capacity");
    expect(d.answerFormat).toMatch(/IKKE oppgitt et konkret behov/i);
    expect(d.answerFormat).toMatch(/mangler.*ikke fyll inn nuller/is);
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
