import { describe, expect, it } from "vitest";
import { normalizeRole, mentionsRole } from "@/lib/chat/roles";

describe("normalizeRole", () => {
  it("maps Welder variants", () => {
    expect(normalizeRole("Welder")).toBe("Welder");
    expect(normalizeRole("sveiser")).toBe("Welder");
    expect(normalizeRole("Sveiser")).toBe("Welder");
  });

  it("maps Steel fixer variants including the 'Stilfixer' typo", () => {
    expect(normalizeRole("Stilfixer")).toBe("Steel fixer");
    expect(normalizeRole("Steel fixer")).toBe("Steel fixer");
    expect(normalizeRole("Stålfikser")).toBe("Steel fixer");
    expect(normalizeRole("Armeringsarbeider")).toBe("Steel fixer");
  });

  it("maps Carpenter variants", () => {
    expect(normalizeRole("Carpenter")).toBe("Carpenter");
    expect(normalizeRole("Tømrer")).toBe("Carpenter");
    expect(normalizeRole("Forskalingssnekker")).toBe("Carpenter");
  });

  it("returns null when no role is present", () => {
    expect(normalizeRole("budsjett")).toBeNull();
    expect(mentionsRole("budsjett")).toBe(false);
    expect(mentionsRole("vi trenger en sveiser")).toBe(true);
  });

  it("prefers the longest alias (steel fixer over a partial)", () => {
    expect(normalizeRole("vi mangler en steel fixer til")).toBe("Steel fixer");
  });
});
