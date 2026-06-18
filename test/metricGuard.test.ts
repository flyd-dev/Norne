/**
 * Generalized named-money-metric guard (#16/#17): a generic Endre total must not
 * be passed off as kontraktsverdi, forventet resultat, resultat, etc.
 */

import { describe, expect, it } from "vitest";
import { guardUnverifiedMetric } from "@/lib/chat/answerVerifier";

const base = {
  projectName: "AFBO NORA",
  projectNumber: "3025",
  hasVerifiedValue: false,
  onlyGenericEndreTotals: true,
};

describe("guardUnverifiedMetric", () => {
  it("fires for contract_value when a money figure is invented from Endre totals", () => {
    const r = guardUnverifiedMetric({ ...base, metric: "contract_value", answer: "Kontraktsverdi: 22 938 804 kr" });
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe("contract_value_unverified");
    expect(r.replacement).toMatch(/ikke et eget felt for kontraktsverdi/i);
  });

  it("fires for expected_result (the #16 mislabeling of TotalAmount)", () => {
    const r = guardUnverifiedMetric({ ...base, metric: "expected_result", answer: "Forventet resultat: 22 938 804,40" });
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe("expected_result_unverified");
    expect(r.replacement).toMatch(/forventet resultat/i);
  });

  it("does NOT fire when a real field was verified", () => {
    const r = guardUnverifiedMetric({ ...base, metric: "contract_value", hasVerifiedValue: true, answer: "150 705 668 kr" });
    expect(r.triggered).toBe(false);
  });

  it("does NOT fire when the numbers are not generic Endre totals", () => {
    const r = guardUnverifiedMetric({ ...base, metric: "result", onlyGenericEndreTotals: false, answer: "20 110 049 kr" });
    expect(r.triggered).toBe(false);
  });

  it("does NOT fire when the answer states no money figure", () => {
    const r = guardUnverifiedMetric({ ...base, metric: "contract_value", answer: "Endre har ikke dette feltet." });
    expect(r.triggered).toBe(false);
  });

  it("ignores non-money metrics (e.g. dates/hours)", () => {
    const r = guardUnverifiedMetric({ ...base, metric: "start_date", answer: "31. desember 2025" });
    expect(r.triggered).toBe(false);
  });
});
