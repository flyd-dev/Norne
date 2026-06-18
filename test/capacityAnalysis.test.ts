import { describe, expect, it } from "vitest";
import { parseCapacityDemand } from "@/lib/chat/capacity";
import {
  analyzeCapacity,
  extractAvailableHours,
  formatHours,
  formatCapacityNote,
} from "@/lib/chat/capacityAnalysis";

const EXAMPLE =
  "Vi skal starte nytt prosjekt i august. Ca. 29.000 timer. Fordeling 30% Welder, 20% Stilfixer og resterende Carpenter.";

describe("formatHours", () => {
  it("inserts Norwegian thousands spacing", () => {
    expect(formatHours(8700)).toBe("8 700");
    expect(formatHours(14500)).toBe("14 500");
    expect(formatHours(500)).toBe("500");
  });
});

describe("extractAvailableHours", () => {
  it("reads available hours per role from staffing-plan lines", () => {
    const chunks = [
      { text: "Welder: tilgjengelig 9000 timer i august" },
      { text: "Steel fixer ledig kapasitet 4000 timer" },
      { text: "Carpenter tilgjengelig 12000 timer" },
      { text: "Generell tekst uten tall" },
    ];
    const map = extractAvailableHours(chunks);
    expect(map.get("Welder")).toBe(9000);
    expect(map.get("Steel fixer")).toBe(4000);
    expect(map.get("Carpenter")).toBe(12000);
  });

  it("ignores lines without an availability keyword", () => {
    const map = extractAvailableHours([{ text: "Welder jobber 8 timer per dag" }]);
    expect(map.size).toBe(0);
  });
});

describe("analyzeCapacity", () => {
  it("computes gaps when availability is present", () => {
    const demand = parseCapacityDemand(EXAMPLE)!;
    const analysis = analyzeCapacity(demand, [
      { text: "Welder: tilgjengelig 9000 timer" },
      { text: "Steel fixer ledig 4000 timer" },
      { text: "Carpenter tilgjengelig 12000 timer" },
    ]);
    expect(analysis.hasAvailability).toBe(true);
    const byRole = Object.fromEntries(analysis.gaps.map((g) => [g.role, g]));
    expect(byRole["Welder"].surplus).toBe(9000 - 8700); // 300 surplus
    expect(byRole["Steel fixer"].surplus).toBe(4000 - 5800); // -1800 shortfall
    expect(byRole["Carpenter"].surplus).toBe(12000 - 14500); // -2500 shortfall
  });

  it("flags missing availability and still keeps the demand breakdown", () => {
    const demand = parseCapacityDemand(EXAMPLE)!;
    const analysis = analyzeCapacity(demand, [
      { text: "Ark: Rotasjonsplan\nNoe tekst uten kapasitetstall." },
    ]);
    expect(analysis.hasAvailability).toBe(false);
    expect(analysis.demand.length).toBe(3);
    const note = formatCapacityNote(analysis);
    expect(note).toMatch(/bemanningsplanen/i);
    expect(note).toContain("8 700"); // Welder demand still shown
  });
});
