import { describe, expect, it } from "vitest";
import {
  parseNorwegianNumber,
  readMetricField,
  resolveMetric,
} from "@/lib/chat/metricResolver";

describe("resolveMetric — synonyms", () => {
  it("maps kontraktsverdi / kontraktssum / avtalesum to contract_value", () => {
    for (const label of ["kontraktsverdi", "kontraktssum", "avtalesum", "contract value"]) {
      expect(resolveMetric(`Hva er ${label}?`)?.metric).toBe("contract_value");
    }
  });

  it("tolerates the typo 'kongraksverdi'", () => {
    const m = resolveMetric("Hva er total kongraksverdi på Pilestredet?");
    expect(m?.metric).toBe("contract_value");
    expect(m?.fuzzy).toBe(true);
  });

  it("prefers the more specific metric (forventet resultat over resultat)", () => {
    expect(resolveMetric("forventet resultat")?.metric).toBe("expected_result");
    expect(resolveMetric("hva er resultatet")?.metric).toBe("result");
  });

  it("separates material/other/total costs", () => {
    expect(resolveMetric("materialkostnader")?.metric).toBe("material_costs");
    expect(resolveMetric("andre kostnader")?.metric).toBe("other_costs");
    expect(resolveMetric("totale kostnader")?.metric).toBe("total_costs");
    expect(resolveMetric("kostnader")?.metric).toBe("total_costs");
  });

  it("maps hours, dates, cmr and backlog", () => {
    expect(resolveMetric("estimerte timer")?.metric).toBe("estimated_hours");
    expect(resolveMetric("startdato")?.metric).toBe("start_date");
    expect(resolveMetric("sluttdato")?.metric).toBe("end_date");
    expect(resolveMetric("CMR")?.metric).toBe("cmr");
    expect(resolveMetric("ordrebeholdning")?.metric).toBe("backlog");
  });

  it("returns null when no metric is present", () => {
    expect(resolveMetric("Hvilke prosjekter finnes?")).toBeNull();
  });
});

describe("parseNorwegianNumber", () => {
  it("parses space-grouped amounts", () => {
    expect(parseNorwegianNumber("150 705 668 kr")).toBe(150705668);
    expect(parseNorwegianNumber("35 094 522")).toBe(35094522);
  });

  it("parses comma decimals and ignores trailing text", () => {
    expect(parseNorwegianNumber("1.234,5 kr")).toBe(1234.5);
  });

  it("returns null when there is no number", () => {
    expect(parseNorwegianNumber("ingen tall her")).toBeNull();
  });
});

describe("readMetricField", () => {
  it("reads a metric value by case/separator-insensitive field name", () => {
    expect(
      readMetricField({ ContractValue: 150705668 }, "contract_value"),
    ).toBe(150705668);
    expect(
      readMetricField({ kontraktsverdi: "150 705 668" }, "contract_value"),
    ).toBe(150705668);
  });

  it("returns null when the field is absent", () => {
    expect(readMetricField({ navn: "Pilestredet" }, "contract_value")).toBeNull();
  });
});
