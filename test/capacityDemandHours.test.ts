/**
 * #1 — persons→hours capacity demand. Availability is modelled in PERSONS per
 * month; demand is in HOURS. The analysis converts the relevant month's persons
 * to hours (× 208 ≈ 48 t/uke), compares PER MONTH, never sums across months, and
 * never produces the rotation-grid million-hour totals.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredStructuredTable } from "@/lib/documents/types";
import {
  readStructuredAvailability,
  availableHoursForMonth,
  HOURS_PER_PERSON_MONTH,
} from "@/lib/chat/capacityStructured";

function kapasitetsanalyse(): StoredStructuredTable {
  const row = (month: string, role: "Steel fixer" | "Carpenter" | "Welder", persons: number) => ({
    month, role, rawRole: role, availableHours: persons, assignedHours: null, person: null,
  });
  return {
    documentId: "D1",
    documentName: "bemanningsplan.xlsx",
    sheetName: "Kapasitetsanalyse",
    columns: {},
    rows: [
      row("2026-07", "Steel fixer", 31.5), row("2026-07", "Carpenter", 57.8), row("2026-07", "Welder", 15.8),
      row("2026-08", "Steel fixer", 31.5), row("2026-08", "Carpenter", 57.8), row("2026-08", "Welder", 15.8),
    ],
  };
}

describe("availableHoursForMonth", () => {
  const avail = readStructuredAvailability([kapasitetsanalyse()]);

  it("converts a month's persons to hours (× 208)", () => {
    const aug = availableHoursForMonth(avail, "august")!;
    expect(aug.monthLabel).toBe("2026-08");
    expect(aug.byRole.get("Carpenter")).toBeCloseTo(57.8 * HOURS_PER_PERSON_MONTH, 5);
    expect(aug.byRole.get("Steel fixer")).toBeCloseTo(31.5 * HOURS_PER_PERSON_MONTH, 5);
  });

  it("matches an ISO month label too", () => {
    const jul = availableHoursForMonth(avail, "2026-07")!;
    expect(jul.monthLabel).toBe("2026-07");
    expect(jul.byRole.get("Welder")).toBeCloseTo(15.8 * HOURS_PER_PERSON_MONTH, 5);
  });

  it("returns null for an unknown / missing month (no cross-month summing)", () => {
    expect(availableHoursForMonth(avail, "desember")).toBeNull();
    expect(availableHoursForMonth(avail, null)).toBeNull();
  });
});

// --- Orchestrator-level: the demand answer uses per-month hours --------------

vi.mock("@/lib/firestore/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firestore/service")>();
  return { ...actual, getAccounts: vi.fn(), getProjects: vi.fn(), getBudgetLines: vi.fn(), getQuantities: vi.fn() };
});
const cap = vi.hoisted(() => ({ inputs: [] as { systemPrompt: string; userPrompt: string }[] }));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "test",
    generateAnswer: async (i: { systemPrompt: string; userPrompt: string }) => {
      cap.inputs.push(i);
      return "Et svar.";
    },
  }),
}));
// A Rotasjonsplan-like chunk whose serials would sum to millions if scraped.
vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async () => [
    { documentId: "D1", documentName: "bemanningsplan.xlsx", fileType: "xlsx", sheetName: "Rotasjonsplan", chunkIndex: 0, score: 1, text: "Uke_start 46195 Welder Ledig kapasitet\nUke_start 46195 Carpenter Ledig kapasitet" },
  ],
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));
vi.mock("@/lib/endre/client", () => ({ getEndreClient: vi.fn() }));
const store = vi.hoisted(() => ({ tables: [] as StoredStructuredTable[] }));
vi.mock("@/lib/documents/store", () => ({ getStructuredTables: async () => store.tables }));

import { runChat } from "@/lib/chat/orchestrator";
import { getAccounts, getProjects } from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  store.tables = [kapasitetsanalyse()];
  vi.mocked(getAccounts).mockResolvedValue([]);
  vi.mocked(getProjects).mockResolvedValue([]);
  vi.mocked(getEndreClient).mockReturnValue(null);
});

describe("demand analysis (orchestrator) — per-month hours, no millions", () => {
  it("compares august demand against august available hours (estimate noted)", async () => {
    const r = await runChat(
      "Har vi kapasitet til et prosjekt i august 2026 på 29 000 timer, fordelt 30 % Steel fixer, 60 % Carpenter og 10 % Welder?",
      "req",
      [],
    );
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // Available is per-month hours (Carpenter 57.8 × 208 = 12 022), never millions.
    expect(userPrompt).toContain("12 022");
    expect(userPrompt).not.toMatch(/1[\s ]?1\d\d[\s ]?\d\d\d/); // no 1.1M-style figure
    // The estimate guardrail is present.
    expect(userPrompt).toMatch(/ESTIMAT/);
    expect(userPrompt).toMatch(/208 t\/person\/mnd/);
  });
});
