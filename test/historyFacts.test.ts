import { describe, expect, it } from "vitest";
import { extractHistoryFacts } from "@/lib/chat/historyFacts";

describe("extractHistoryFacts", () => {
  it("extracts project name/number and metric values from labelled lines", () => {
    const facts = extractHistoryFacts([
      { role: "user", content: "Oppsummer prosjekt 7100" },
      {
        role: "assistant",
        content:
          "Prosjektnavn: Pilestredet\nProsjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
      },
    ]);
    expect(facts.projectName).toBe("Pilestredet");
    expect(facts.projectNumber).toBe("7100");
    expect(facts.metrics.contract_value).toBe(150705668);
  });

  it("does not mistake a decimal like 29.000 for a project number", () => {
    const facts = extractHistoryFacts([
      { role: "user", content: "Vi skal bruke ca. 29.000 timer i august." },
    ]);
    expect(facts.projectNumber).toBeNull();
  });

  it("returns empty facts for unrelated history", () => {
    const facts = extractHistoryFacts([
      { role: "user", content: "Hei, hvordan går det?" },
    ]);
    expect(facts.projectName).toBeNull();
    expect(facts.projectNumber).toBeNull();
    expect(facts.metrics).toEqual({});
  });
});
