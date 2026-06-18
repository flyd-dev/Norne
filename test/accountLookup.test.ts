import { describe, expect, it } from "vitest";
import {
  detectAccountLookup,
  expandSearchTerms,
  rankAccounts,
} from "@/lib/chat/accountLookup";
import type { FirestoreDoc } from "@/lib/firestore/types";

describe("detectAccountLookup — intent patterns", () => {
  const positives: [string, string][] = [
    ["Hva fører jeg arbeidshansker på?", "arbeidshansker"],
    ["Hvilken konto bruker jeg for arbeidshansker?", "arbeidshansker"],
    ["Hvor bokfører jeg arbeidshansker?", "arbeidshansker"],
    ["Hva skal arbeidshansker konteres på?", "arbeidshansker"],
    ["Hvilket kontonummer for arbeidshansker?", "arbeidshansker"],
    ["Hva føres arbeidshansker som?", "arbeidshansker"],
    ["Hvor skal jeg føre arbeidshansker?", "arbeidshansker"],
  ];

  it.each(positives)("detects a lookup in %j", (message, subject) => {
    const result = detectAccountLookup(message);
    expect(result.isLookup).toBe(true);
    expect(result.subject).toBe(subject);
  });

  it("ignores non-lookup questions", () => {
    expect(detectAccountLookup("Hvilke prosjekter finnes?").isLookup).toBe(false);
    expect(detectAccountLookup("Vis meg alle kontoer").isLookup).toBe(false);
    expect(detectAccountLookup("Hei, hva kan du?").isLookup).toBe(false);
  });

  it("strips leading filler words from the subject", () => {
    const result = detectAccountLookup("Hva fører jeg et nytt verktøy på?");
    expect(result.subject).toBe("nytt verktøy");
  });
});

describe("expandSearchTerms — query expansion", () => {
  it("expands arbeidshansker with related accounting terms", () => {
    const terms = expandSearchTerms("arbeidshansker");
    for (const expected of [
      "arbeidshansker",
      "verneutstyr",
      "arbeidsklær",
      "hms",
      "driftsmateriell",
      "forbruksmateriell",
    ]) {
      expect(terms).toContain(expected);
    }
  });

  it("expands a synonym (hansker) into the same cluster", () => {
    const terms = expandSearchTerms("hansker");
    expect(terms).toContain("verneutstyr");
    expect(terms).toContain("hms");
  });

  it("returns just the subject words when no cluster matches", () => {
    const terms = expandSearchTerms("frimerker");
    expect(terms).toEqual(["frimerker"]);
  });
});

describe("rankAccounts — top relevant matches only", () => {
  const accounts: FirestoreDoc[] = [
    { id: "a1", number: "4000", name: "Varekjøp" },
    { id: "a2", number: "6570", name: "Driftsmateriell og verneutstyr" },
    { id: "a3", number: "7140", name: "Reisekostnad" },
    { id: "a4", number: "6540", name: "Inventar og forbruksmateriell" },
  ];

  it("ranks accounts whose text matches the expanded terms", () => {
    const ranked = rankAccounts(
      accounts,
      expandSearchTerms("arbeidshansker"),
      10,
    );
    expect(ranked.length).toBeGreaterThan(0);
    // The verneutstyr/driftsmateriell account should rank first.
    expect(ranked[0].account.id).toBe("a2");
    expect(ranked.map((r) => r.account.id)).not.toContain("a3");
  });

  it("returns nothing when no account matches", () => {
    expect(rankAccounts(accounts, ["frimerker"], 10)).toEqual([]);
  });

  it("respects the limit", () => {
    const many: FirestoreDoc[] = Array.from({ length: 20 }, (_, i) => ({
      id: `x${i}`,
      name: "verneutstyr",
    }));
    expect(rankAccounts(many, ["verneutstyr"], 5).length).toBe(5);
  });
});
