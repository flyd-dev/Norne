import { describe, expect, it } from "vitest";
import {
  CAPABILITIES_ANSWER,
  isCapabilitiesQuestion,
  normalizeForMeta,
} from "@/lib/chat/capabilities";

describe("isCapabilitiesQuestion", () => {
  const positives = [
    "Hva kan du gjøre?",
    "hva kan du gjore",
    "Hva kan du hjelpe med?",
    "Hva kan du hjelpe meg med?",
    "Hva kan jeg spørre deg om?",
    "Hva kan jeg spørre om?",
    "Hjelp",
    "Hjelp!",
    "vis hjelp",
    "Gi meg eksempler",
    "vis meg eksempler",
    "Hvordan bruker jeg deg?",
    "Hvordan fungerer du?",
    "Hva kan assistenten gjøre?",
    "Hva kan botten gjøre?",
    "Hvem er du?",
  ];
  for (const q of positives) {
    it(`treats "${q}" as a meta/help question`, () => {
      expect(isCapabilitiesQuestion(q)).toBe(true);
    });
  }

  const negatives = [
    "Oppsummer prosjekt 7100",
    "Hva er kontraktsverdien på Pilestredet?",
    "Hva fører jeg arbeidshansker på?",
    "Hjelp meg å finne kontraktsverdien på Pilestredet", // data question, not meta
    "Hvordan bruker jeg konto 6570?", // data question, not meta
    "Har vi kapasitet til 29 000 timer i august?",
    "Vis budsjettlinjer for prosjekt 7100",
    "",
  ];
  for (const q of negatives) {
    it(`does NOT treat "${q}" as a meta/help question`, () => {
      expect(isCapabilitiesQuestion(q)).toBe(false);
    });
  }
});

describe("normalizeForMeta", () => {
  it("lowercases, strips punctuation and collapses whitespace, keeping æøå", () => {
    expect(normalizeForMeta("  Hva kan du GJØRE?! ")).toBe("hva kan du gjøre");
  });
});

describe("CAPABILITIES_ANSWER", () => {
  it("describes the capability areas without exposing data or sources", () => {
    expect(CAPABILITIES_ANSWER).toMatch(/Prosjekter:/);
    expect(CAPABILITIES_ANSWER).toMatch(/Kontoføring:/);
    expect(CAPABILITIES_ANSWER).toMatch(/Bemanning og kapasitet:/);
    expect(CAPABILITIES_ANSWER).toMatch(/Eksempler:/);
    // It must not leak concrete live values (it is a static help text).
    expect(CAPABILITIES_ANSWER).not.toMatch(/150 705 668/);
  });
});
