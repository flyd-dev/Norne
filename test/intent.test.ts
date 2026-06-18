import { describe, expect, it } from "vitest";
import { detectIntent } from "@/lib/chat/intent";

describe("detectIntent", () => {
  it("detects accounts (Norwegian)", () => {
    const intent = detectIntent("Vis meg alle kontoer");
    expect(intent.topics).toContain("accounts");
    expect(intent.needsProject).toBe(false);
  });

  it("detects projects (English)", () => {
    const intent = detectIntent("What projects do we have?");
    expect(intent.topics).toContain("projects");
  });

  it("detects budget lines and flags needsProject", () => {
    const intent = detectIntent("Vis budsjettlinjer for prosjektet");
    expect(intent.topics).toContain("budgetLines");
    expect(intent.needsProject).toBe(true);
  });

  it("detects quantities and flags needsProject", () => {
    const intent = detectIntent("Hvor mange mengder er registrert?");
    expect(intent.topics).toContain("quantities");
    expect(intent.needsProject).toBe(true);
  });

  it("extracts an explicit 20-char project id", () => {
    const intent = detectIntent("budsjett for GSLeXiSkaiAkEqcuFxIx");
    expect(intent.explicitProjectId).toBe("GSLeXiSkaiAkEqcuFxIx");
  });

  it("falls back to projects + accounts when nothing matches", () => {
    const intent = detectIntent("Hei, hva kan du hjelpe med?");
    expect(intent.topics).toEqual(expect.arrayContaining(["projects", "accounts"]));
    expect(intent.needsProject).toBe(false);
  });

  it("detects account-lookup intent for 'Hva fører jeg arbeidshansker på?'", () => {
    const intent = detectIntent("Hva fører jeg arbeidshansker på?");
    expect(intent.accountLookup).toBe(true);
    expect(intent.lookupSubject).toBe("arbeidshansker");
    expect(intent.topics).toContain("accounts");
  });

  it("does not pull projects into an account-lookup question", () => {
    const intent = detectIntent("Hva fører jeg arbeidshansker på?");
    expect(intent.topics).not.toContain("projects");
  });

  it("expands the search terms for an account lookup", () => {
    const intent = detectIntent("Hva fører jeg arbeidshansker på?");
    for (const term of ["verneutstyr", "arbeidsklær", "hms", "driftsmateriell"]) {
      expect(intent.searchTerms).toContain(term);
    }
  });
});
