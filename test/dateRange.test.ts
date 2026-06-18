import { describe, expect, it } from "vitest";
import {
  parseMonth,
  parseMonthRange,
  filterMonthsByBound,
} from "@/lib/chat/dateRange";

describe("parseMonth", () => {
  it("parses month name and optional year", () => {
    expect(parseMonth("september 2026")).toEqual({ month: 9, year: 2026 });
    expect(parseMonth("August")).toEqual({ month: 8, year: null });
    expect(parseMonth("ingen måned her")).toBeNull();
  });
});

describe("parseMonthRange", () => {
  it("treats 'frem til september 2026' as up-to-and-including", () => {
    expect(parseMonthRange("Gi meg det du har frem til september 2026")).toEqual({
      kind: "upTo",
      month: 9,
      year: 2026,
    });
  });

  it("treats 'til og med' as up-to-and-including", () => {
    expect(parseMonthRange("vis til og med mai")).toEqual({
      kind: "upTo",
      month: 5,
      year: null,
    });
  });

  it("treats 'fra september' as from-onwards and 'etter' as after", () => {
    expect(parseMonthRange("fra september 2026")).toEqual({
      kind: "from",
      month: 9,
      year: 2026,
    });
    expect(parseMonthRange("etter september")).toEqual({
      kind: "after",
      month: 9,
      year: null,
    });
  });

  it("returns null when no range is expressed", () => {
    expect(parseMonthRange("hvor mange timer har vi i mai?")).toBeNull();
  });
});

describe("filterMonthsByBound", () => {
  const rows = [
    "januar 2026",
    "februar 2026",
    "august 2026",
    "september 2026",
    "oktober 2026",
    "november 2026",
    "desember 2026",
  ].map((month) => ({ month }));

  it("'frem til september 2026' includes through September and excludes Oct–Dec", () => {
    const bound = parseMonthRange("frem til september 2026")!;
    const out = filterMonthsByBound(rows, bound).map((r) => r.month);
    expect(out).toContain("september 2026");
    expect(out).toContain("august 2026");
    expect(out).not.toContain("oktober 2026");
    expect(out).not.toContain("november 2026");
    expect(out).not.toContain("desember 2026");
  });

  it("'fra september' keeps September onwards", () => {
    const bound = parseMonthRange("fra september 2026")!;
    const out = filterMonthsByBound(rows, bound).map((r) => r.month);
    expect(out).toEqual([
      "september 2026",
      "oktober 2026",
      "november 2026",
      "desember 2026",
    ]);
  });

  it("drops months whose cell cannot be parsed", () => {
    const bound = parseMonthRange("frem til september")!;
    const out = filterMonthsByBound(
      [{ month: "august" }, { month: "ukjent" }],
      bound,
    );
    expect(out.map((r) => r.month)).toEqual(["august"]);
  });
});
