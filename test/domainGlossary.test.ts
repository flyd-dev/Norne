import { describe, expect, it } from "vitest";
import {
  CONCEPT_TERMS,
  detectConcepts,
  expandGlossaryTerms,
} from "@/lib/chat/domainGlossary";

describe("detectConcepts", () => {
  it("maps PPE words to the ppe concept", () => {
    expect(detectConcepts("arbeidshansker")).toContain("ppe");
    expect(detectConcepts("Hvor fører jeg vernesko?")).toContain("ppe");
    expect(detectConcepts("hms-utstyr og verneklær")).toContain("ppe");
  });

  it("maps capacity and staffing words", () => {
    expect(detectConcepts("ledig kapasitet")).toContain("capacity");
    expect(detectConcepts("bemanningsplan og rotasjonsplan")).toContain(
      "staffing_plan",
    );
  });

  it("maps account/bookkeeping words", () => {
    expect(detectConcepts("kontoplan")).toContain("account");
    expect(detectConcepts("hvor skal jeg bokføre dette")).toContain("account");
  });
});

describe("expandGlossaryTerms", () => {
  it("expands a PPE term to the whole verneutstyr cluster", () => {
    const terms = expandGlossaryTerms("arbeidshansker");
    for (const t of ["verneutstyr", "driftsmateriell", "arbeidsklær", "hms"]) {
      expect(terms).toContain(t);
    }
  });

  it("includes vernesko and reaches the verneutstyr cluster", () => {
    const terms = expandGlossaryTerms("vernesko");
    expect(terms).toContain("vernesko");
    expect(terms).toContain("verneutstyr");
  });

  it("keeps the original tokens", () => {
    expect(expandGlossaryTerms("sveiser i august")).toContain("sveiser");
  });
});

describe("CONCEPT_TERMS shape", () => {
  it("has the four expected concepts and no empty clusters", () => {
    expect(Object.keys(CONCEPT_TERMS).sort()).toEqual([
      "account",
      "capacity",
      "ppe",
      "staffing_plan",
    ]);
    for (const terms of Object.values(CONCEPT_TERMS)) {
      expect(terms.length).toBeGreaterThan(0);
    }
  });
});
