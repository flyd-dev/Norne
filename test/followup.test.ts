import { describe, expect, it } from "vitest";
import { isFollowUp, resolveFollowUp } from "@/lib/chat/followup";

const PRIOR =
  "Vi skal starte nytt prosjekt i august. Ca. 29.000 timer. Fordeling 30% Welder, 20% Stilfixer og resterende Carpenter. Har vi kapasitet eller må vi hente inn flere folk?";

describe("isFollowUp", () => {
  it("recognises short document references", () => {
    expect(isFollowUp("Du har bemanningsplanen. sjekk den")).toBe(true);
    expect(isFollowUp("sjekk dokumentet")).toBe(true);
    expect(isFollowUp("bruk bemanningsplanen")).toBe(true);
    expect(isFollowUp("kan du regne på det?")).toBe(true);
  });

  it("treats a fresh, self-contained question as not a follow-up", () => {
    expect(isFollowUp(PRIOR)).toBe(false);
    expect(isFollowUp("Hvilke prosjekter finnes?")).toBe(false);
  });

  it("recognises 'gi meg det du har' and 'frem til <måned>' continuations", () => {
    expect(isFollowUp("Gi meg det du har frem til september 2026")).toBe(true);
    expect(isFollowUp("vis det du fant")).toBe(true);
    expect(isFollowUp("frem til desember")).toBe(true);
  });
});

describe("resolveFollowUp — continuation of monthly capacity", () => {
  const MONTHLY = "Kan du gi meg tilgjengelig kapasitet hver måned ut året?";
  it("merges 'frem til september' with the prior monthly question", () => {
    const r = resolveFollowUp("Gi meg det du har frem til september 2026", [
      { role: "user", content: MONTHLY },
      { role: "assistant", content: "Her er kapasiteten per måned …" },
    ]);
    expect(r.isFollowUp).toBe(true);
    expect(r.priorQuestion).toBe(MONTHLY);
    expect(r.retrievalText).toContain("hver måned");
    expect(r.retrievalText).toContain("september");
  });
});

describe("resolveFollowUp", () => {
  it("resolves 'sjekk den' against the prior substantive user question", () => {
    const r = resolveFollowUp("Du har bemanningsplanen. sjekk den", [
      { role: "user", content: PRIOR },
      { role: "assistant", content: "Jeg har ikke nok informasjon …" },
    ]);
    expect(r.isFollowUp).toBe(true);
    expect(r.priorQuestion).toBe(PRIOR);
    // The retrieval text now carries the project demand from the prior turn.
    expect(r.retrievalText).toContain("29.000");
    expect(r.retrievalText).toContain("Welder");
    expect(r.retrievalText).toContain("sjekk den");
  });

  it("leaves a self-contained question unchanged", () => {
    const r = resolveFollowUp(PRIOR, []);
    expect(r.isFollowUp).toBe(false);
    expect(r.retrievalText).toBe(PRIOR);
    expect(r.priorQuestion).toBeNull();
  });

  it("does not crash without history", () => {
    const r = resolveFollowUp("sjekk den");
    expect(r.isFollowUp).toBe(true);
    expect(r.priorQuestion).toBeNull();
    expect(r.retrievalText).toBe("sjekk den");
  });
});
