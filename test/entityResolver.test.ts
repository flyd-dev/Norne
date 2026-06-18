import { describe, expect, it } from "vitest";
import {
  extractProjectNameFromText,
  extractProjectNumberFromText,
  resolveEntity,
} from "@/lib/chat/entityResolver";
import type { ProjectLike } from "@/lib/chat/projectResolver";

const PROJECTS: ProjectLike[] = [
  { id: "F_AAA111", project_name: "Pilestredet", project_number: "7100" },
  { id: "F_BBB222", project_name: "Skaidi", project_number: "7200" },
];

const HISTORY = [
  { role: "user" as const, content: "Oppsummer prosjekt 7100" },
  {
    role: "assistant" as const,
    content:
      "Prosjektnavn: Pilestredet\nProsjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
  },
];

describe("text extraction", () => {
  it("extracts an explicit project number", () => {
    expect(extractProjectNumberFromText("Oppsummer prosjekt 7100")).toBe("7100");
  });

  it("extracts a project name from '<Name> prosjektet'", () => {
    expect(
      extractProjectNameFromText("Hva er kontraktsverdi på Pilestredet prosjektet?"),
    ).toBe("Pilestredet");
  });

  it("does not treat a bare number as a name", () => {
    expect(extractProjectNameFromText("Oppsummer prosjekt 7100")).toBeNull();
  });

  it("does not read a bare 4-digit year as a project number", () => {
    expect(
      extractProjectNumberFromText("Gi meg det du har frem til september 2026"),
    ).toBeNull();
    expect(extractProjectNumberFromText("kapasitet ut 2026")).toBeNull();
  });

  it("still reads a real bare project number that is not a year", () => {
    expect(extractProjectNumberFromText("se på 7100 takk")).toBe("7100");
  });

  it("keeps an explicitly labelled number even if it looks like a year", () => {
    expect(extractProjectNumberFromText("prosjekt 2026")).toBe("2026");
  });
});

describe("resolveEntity", () => {
  it("resolves a named project against the projects list (high confidence)", () => {
    const e = resolveEntity({
      message: "Hva er total kontraktsverdi på Pilestredet prosjektet?",
      projects: PROJECTS,
    });
    expect(e.projectNumber).toBe("7100");
    expect(e.projectName).toBe("Pilestredet");
    expect(e.confidence).toBe("high");
    expect(e.matchedFrom).toContain("projects");
  });

  it("resolves an elliptical follow-up from history", () => {
    const e = resolveEntity({
      message: "Hva er kontraktsverdien?",
      history: HISTORY,
    });
    expect(e.projectNumber).toBe("7100");
    expect(e.projectName).toBe("Pilestredet");
    expect(e.matchedFrom).toContain("history");
  });

  it("returns no project when nothing is referenced", () => {
    const e = resolveEntity({ message: "Hvilke prosjekter finnes?" });
    expect(e.projectNumber).toBeNull();
    expect(e.projectName).toBeNull();
    expect(e.confidence).toBe("low");
  });
});
