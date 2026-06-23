import { describe, expect, it } from "vitest";
import {
  isSmalltalkMessage,
  mentionsCompanyDomain,
  isCapabilitiesQuestion,
} from "@/lib/chat/capabilities";

describe("isSmalltalkMessage", () => {
  it("matches whole-message greetings / acks / thanks", () => {
    for (const m of ["hei", "Hallo!", "funker du", "Fungerer du?", "takk", "ok", "god morgen"]) {
      expect(isSmalltalkMessage(m)).toBe(true);
    }
  });

  it("does NOT match real questions that merely start like smalltalk", () => {
    for (const m of [
      "funker budsjettet for 7100?",
      "hei, hva er kontraktsverdien på Pilestredet?",
      "ok men hva sier avtalen",
    ]) {
      expect(isSmalltalkMessage(m)).toBe(false);
    }
  });
});

describe("mentionsCompanyDomain (high recall)", () => {
  // Note: account-lookups like "hva fører jeg arbeidshansker på?" carry no domain
  // keyword — they're caught by intent.hasDataSignal (detectAccountLookup) in the
  // orchestrator, not by this cue. This covers the keyword-bearing questions.
  it("flags project/capacity/document/case questions", () => {
    for (const m of [
      "oppsummer prosjekt 7100",
      "vis kapasitet frem til september",
      "hva sier Windport-avtalen?",
      "når var møtet med Lyngdal kommune?",
      "hva handler saken om?",
      "hvor mye er fakturert?",
      "hva står i kontoplanen?",
    ]) {
      expect(mentionsCompanyDomain(m)).toBe(true);
    }
  });

  it("does NOT flag general conversation", () => {
    for (const m of [
      "skriv et dikt om våren",
      "hva er hovedstaden i Norge?",
      "kan du forklare hva en LLM er?",
      "hvordan har du det?",
    ]) {
      expect(mentionsCompanyDomain(m)).toBe(false);
    }
  });
});

describe("gates don't overlap with capabilities", () => {
  it("smalltalk is not a capabilities question and vice versa", () => {
    expect(isCapabilitiesQuestion("funker du")).toBe(false);
    expect(isSmalltalkMessage("hva kan du gjøre?")).toBe(false);
  });
});
