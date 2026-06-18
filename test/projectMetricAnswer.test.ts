import { describe, expect, it } from "vitest";
import {
  buildProjectMetricAnswer,
  formatNumberNo,
} from "@/lib/chat/projectMetricAnswer";

describe("formatNumberNo", () => {
  it("groups thousands with spaces", () => {
    expect(formatNumberNo(150705668)).toBe("150 705 668");
    expect(formatNumberNo(87389)).toBe("87 389");
  });
});

describe("buildProjectMetricAnswer", () => {
  it("answers a contract-value question with project reference and kr", () => {
    const answer = buildProjectMetricAnswer({
      metric: "contract_value",
      value: 150705668,
      projectName: "Pilestredet",
      projectNumber: "7100",
      question: "Hva er total kontraktsverdi på Pilestredet prosjektet?",
    });
    expect(answer).toBe(
      "Total kontraktsverdi for Pilestredet (prosjekt 7100) er 150 705 668 kr.",
    );
  });

  it("formats hours with 'timer'", () => {
    const answer = buildProjectMetricAnswer({
      metric: "estimated_hours",
      value: 87389,
      projectName: null,
      projectNumber: "7100",
      question: "Hvor mange timer?",
    });
    expect(answer).toContain("87 389 timer");
    expect(answer).toContain("prosjekt 7100");
  });
});
