import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirestoreDoc } from "@/lib/firestore/types";

// Mock Firestore data access (keep the real COLLECTIONS helpers).
vi.mock("@/lib/firestore/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firestore/service")>();
  return {
    ...actual,
    getAccounts: vi.fn(),
    getProjects: vi.fn(),
    getBudgetLines: vi.fn(),
    getQuantities: vi.fn(),
  };
});

// Mock the LLM provider: capture the prompts, return a fixed answer (no key/net).
const cap = vi.hoisted(() => ({
  inputs: [] as { systemPrompt: string; userPrompt: string; context: unknown }[],
}));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "test",
    generateAnswer: async (input: {
      systemPrompt: string;
      userPrompt: string;
      context: unknown;
    }) => {
      cap.inputs.push(input);
      return "ok";
    },
  }),
}));

import { runChat } from "@/lib/chat/orchestrator";
import {
  getAccounts,
  getBudgetLines,
  getProjects,
  getQuantities,
} from "@/lib/firestore/service";

const mProjects = vi.mocked(getProjects);
const mBudget = vi.mocked(getBudgetLines);
const mQty = vi.mocked(getQuantities);
const mAccounts = vi.mocked(getAccounts);

const PROJECTS: FirestoreDoc[] = [
  { id: "P_AAA111", project_name: "Pilestredet", project_number: "7100" },
  { id: "P_BBB222", project_name: "Skaidi", project_number: "7200" },
];

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  mProjects.mockResolvedValue(PROJECTS);
  mAccounts.mockResolvedValue([]);
  mBudget.mockResolvedValue([
    { id: "b1", cost: 100 },
    { id: "b2", cost: 250 },
  ]);
  mQty.mockResolvedValue([{ id: "q1", amount: 5 }]);
});

describe("runChat — collection tracking", () => {
  it("records `projects` even when resolution is the only reason it was read", async () => {
    // No word "prosjekt" here, so the projects topic is NOT triggered directly —
    // projects is read solely to resolve the number 7100.
    const r = await runChat("Vis budsjettlinjer for 7100", "req");
    expect(r.dataUsed.firestoreCollections).toContain("projects");
    expect(r.dataUsed.firestoreCollections).toContain("projects/P_AAA111/budget_lines");
    expect(r.sources).toEqual(r.dataUsed.firestoreCollections);
    expect(mBudget).toHaveBeenCalledWith("P_AAA111");
  });

  it("does not fetch subcollections for an unknown project, and warns", async () => {
    const r = await runChat("Vis budsjettlinjer for prosjekt 9999", "req");
    expect(mBudget).not.toHaveBeenCalled();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(
      r.dataUsed.firestoreCollections.some((c) => c.includes("/budget_lines")),
    ).toBe(false);
  });

  it("aggregates rows (count + totals) rather than sending raw rows", async () => {
    mBudget.mockResolvedValue(
      Array.from({ length: 27 }, (_, i) => ({ id: `b${i}`, cost: 10 })),
    );
    await runChat("budsjettlinjer for prosjekt 7100", "req");
    const userMsg = cap.inputs.at(-1)!.userPrompt;
    expect(userMsg).toContain('"count": 27');
    expect(userMsg).toContain('"totals"');
    // Only a sample is included, never all 27 raw rows.
    expect(userMsg).toContain('"truncated": true');
  });

  it("includes the no-invention instruction in the system prompt", async () => {
    await runChat("Hvilke prosjekter finnes?", "req");
    const sys = cap.inputs.at(-1)!.systemPrompt;
    expect(sys).toMatch(/Ikke finn på fakta/i);
  });

  it("returns the same response shape regardless of provider", async () => {
    const r = await runChat("Hvilke prosjekter finnes?", "req");
    expect(r).toEqual(
      expect.objectContaining({
        answer: expect.any(String),
        sources: expect.any(Array),
        warnings: expect.any(Array),
        dataUsed: expect.objectContaining({
          firestoreCollections: expect.any(Array),
          documents: expect.any(Array),
        }),
      }),
    );
  });
});
