import { describe, expect, it } from "vitest";
import { guardUnsupportedCapacity, presentsHoursFigure } from "@/lib/chat/answerVerifier";

describe("guardUnsupportedCapacity", () => {
  it("does not fire when the tool returned data (coverage not none)", () => {
    const r = guardUnsupportedCapacity({ coverageNone: false, answer: "Juli: 31,5 timer" });
    expect(r.triggered).toBe(false);
  });

  it("does not fire when the answer states no hours", () => {
    const r = guardUnsupportedCapacity({
      coverageNone: true,
      answer: "Jeg finner ikke kapasitet for perioden.",
    });
    expect(r.triggered).toBe(false);
  });

  it("fires when coverage is none but the draft invented an hours figure", () => {
    const r = guardUnsupportedCapacity({
      coverageNone: true,
      answer: "Dere har 120 timer ledig i september.",
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe("capacity_unverified");
    expect(r.replacement).toMatch(/gjetter ikke på tall/i);
  });

  it("detects grouped and decimal hours figures", () => {
    expect(presentsHoursFigure("1 200 timer")).toBe(true);
    expect(presentsHoursFigure("31,5 timer")).toBe(true);
    expect(presentsHoursFigure("ingen tall her")).toBe(false);
  });
});
