import { describe, expect, it } from "vitest";
import {
  extractHistoryFacts,
  metricForResolvedProject,
} from "@/lib/chat/historyFacts";

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
    // The contract value is grouped under project 7100/Pilestredet.
    expect(
      metricForResolvedProject(
        facts,
        { projectNumber: "7100", projectName: "Pilestredet" },
        "contract_value",
      ),
    ).toBe(150705668);
  });

  it("reads the value, not the project number, from a separator-less sentence", () => {
    // The classic '7 100 kr' bug: the first number on the line is the project
    // number, which must NOT be read as the contract value.
    const facts = extractHistoryFacts([
      { role: "user", content: "Hva er kontraktsverdien?" },
      {
        role: "assistant",
        content:
          "Kontraktsverdi for Pilestredet (prosjekt 7100) er 150 705 668 kr.",
      },
    ]);
    const value = metricForResolvedProject(
      facts,
      { projectNumber: "7100", projectName: "Pilestredet" },
      "contract_value",
    );
    expect(value).toBe(150705668);
    expect(value).not.toBe(7100);
  });

  it("does not apply one project's metric to another project (no cross-leak)", () => {
    const facts = extractHistoryFacts([
      { role: "user", content: "Oppsummer prosjekt 7100" },
      {
        role: "assistant",
        content:
          "Prosjektnavn: Pilestredet\nProsjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
      },
      { role: "user", content: "Oppsummer prosjekt 3025" },
      {
        role: "assistant",
        content: "Prosjektnavn: AFBO NORA\nProsjektnummer: 3025",
      },
    ]);
    // 3025 has no contract value of its own → undefined, never Pilestredet's.
    expect(
      metricForResolvedProject(
        facts,
        { projectNumber: "3025", projectName: "AFBO NORA" },
        "contract_value",
      ),
    ).toBeUndefined();
    // 7100 still resolves to its own value.
    expect(
      metricForResolvedProject(
        facts,
        { projectNumber: "7100", projectName: "Pilestredet" },
        "contract_value",
      ),
    ).toBe(150705668);
  });

  it("does not return a value when only the name matches but numbers disagree", () => {
    const facts = extractHistoryFacts([
      {
        role: "assistant",
        content:
          "Prosjektnavn: Pilestredet\nProsjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
      },
    ]);
    // Same name token but a different, explicit number → not a match.
    expect(
      metricForResolvedProject(
        facts,
        { projectNumber: "3025", projectName: "Pilestredet" },
        "contract_value",
      ),
    ).toBeUndefined();
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
    expect(facts.byProject).toEqual([]);
  });
});
