import { describe, expect, it } from "vitest";
import {
  detectCapacityIntent,
  parseCapacityDemand,
} from "@/lib/chat/capacity";

const EXAMPLE =
  "Vi skal starte nytt prosjekt i august. Ca. 29.000 timer. Fordeling 30% Welder, 20% Stilfixer og resterende Carpenter. Har vi kapasitet eller må vi hente inn flere folk?";

describe("detectCapacityIntent", () => {
  it("detects capacity vocabulary", () => {
    expect(detectCapacityIntent("Har vi kapasitet til et nytt prosjekt?")).toBe(true);
    expect(detectCapacityIntent("Sjekk bemanningsplanen")).toBe(true);
    expect(detectCapacityIntent("Må vi hente inn flere folk?")).toBe(true);
    expect(detectCapacityIntent(EXAMPLE)).toBe(true);
  });

  it("detects role mentions as capacity intent", () => {
    expect(detectCapacityIntent("Hvor mange Welder har vi ledig?")).toBe(true);
    expect(detectCapacityIntent("Trenger vi flere tømrere?")).toBe(true);
  });

  it("does not flag unrelated accounting questions", () => {
    expect(detectCapacityIntent("Hva fører jeg arbeidshansker på?")).toBe(false);
    expect(detectCapacityIntent("Hvilke prosjekter finnes?")).toBe(false);
  });
});

describe("parseCapacityDemand", () => {
  it("parses total hours written as 29.000 timer", () => {
    expect(parseCapacityDemand("Ca. 29.000 timer")?.totalHours).toBe(29000);
    expect(parseCapacityDemand("29 000 timer")?.totalHours).toBe(29000);
    expect(parseCapacityDemand("29000 timer")?.totalHours).toBe(29000);
  });

  it("parses the start month", () => {
    expect(parseCapacityDemand("Vi starter i august, 1000 timer")?.startMonth).toBe(
      "august",
    );
  });

  it("parses the full example into the expected demand breakdown", () => {
    const demand = parseCapacityDemand(EXAMPLE);
    expect(demand).not.toBeNull();
    expect(demand!.totalHours).toBe(29000);
    expect(demand!.startMonth).toBe("august");

    const byRole = Object.fromEntries(
      demand!.roles.map((r) => [r.role, r]),
    );
    expect(byRole["Welder"].percent).toBe(30);
    expect(byRole["Welder"].hours).toBe(8700);
    expect(byRole["Steel fixer"].percent).toBe(20);
    expect(byRole["Steel fixer"].hours).toBe(5800);
    expect(byRole["Carpenter"].percent).toBe(50); // resterende
    expect(byRole["Carpenter"].hours).toBe(14500);
  });

  it("orders roles by canonical order (Welder, Steel fixer, Carpenter)", () => {
    const demand = parseCapacityDemand(EXAMPLE);
    expect(demand!.roles.map((r) => r.role)).toEqual([
      "Welder",
      "Steel fixer",
      "Carpenter",
    ]);
  });

  it("returns null when there is nothing to parse", () => {
    expect(parseCapacityDemand("Hei, hva kan du hjelpe med?")).toBeNull();
  });
});
