import { describe, expect, it } from "vitest";
import {
  MAX_STRING_LEN,
  compactScalars,
  normalizeProject,
  summarizeRows,
} from "@/lib/firestore/normalize";

describe("compactScalars", () => {
  it("keeps scalars, drops nested objects/arrays, truncates long strings", () => {
    const out = compactScalars({
      id: "doc1",
      name: "Test",
      amount: 100,
      active: true,
      nested: { a: 1 },
      list: [1, 2, 3],
      long: "x".repeat(MAX_STRING_LEN + 50),
    });
    expect(out).not.toHaveProperty("id");
    expect(out).not.toHaveProperty("nested");
    expect(out).not.toHaveProperty("list");
    expect(out.name).toBe("Test");
    expect(out.amount).toBe(100);
    expect(out.active).toBe(true);
    expect((out.long as string).length).toBe(MAX_STRING_LEN + 1); // +1 for the ellipsis
  });
});

describe("normalizeProject", () => {
  it("includes id and a resolved name label", () => {
    const out = normalizeProject({ id: "p1", navn: "Solsiden", secretBlob: { x: 1 } });
    expect(out.id).toBe("p1");
    expect(out.name).toBe("Solsiden");
    expect(out).not.toHaveProperty("secretBlob");
  });
});

describe("summarizeRows", () => {
  it("aggregates numeric totals and limits the sample", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `r${i}`,
      cost: 10,
      qty: 2,
      label: `row ${i}`,
    }));
    const summary = summarizeRows(rows);
    expect(summary.count).toBe(25);
    expect(summary.totals.cost).toBe(250);
    expect(summary.totals.qty).toBe(50);
    expect(summary.sample.length).toBeLessThanOrEqual(10);
    expect(summary.truncated).toBe(true);
  });
});
