/**
 * End-to-end clarification tests (spec cases A and I).
 *
 * A vague, context-dependent question asked in a NEW chat (empty history) must
 * return a clarification WITHOUT fetching projects, accounts, Endre or documents,
 * and without mentioning any concrete project. The same phrase WITH relevant
 * in-chat context must be answered normally instead.
 *
 * runChat is exercised with Firestore, the LLM, document search, the Endre client
 * and the structured-table store mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirestoreDoc } from "@/lib/firestore/types";

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

const cap = vi.hoisted(() => ({
  inputs: [] as { systemPrompt: string; userPrompt: string }[],
  reply: "Et svar fra modellen.",
}));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "test",
    generateAnswer: async (input: { systemPrompt: string; userPrompt: string }) => {
      cap.inputs.push(input);
      return cap.reply;
    },
  }),
}));

vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async () => [],
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));

vi.mock("@/lib/endre/client", () => ({ getEndreClient: vi.fn() }));

vi.mock("@/lib/documents/store", () => ({
  getStructuredTables: async () => [],
}));

import { runChat } from "@/lib/chat/orchestrator";
import { getAccounts, getProjects } from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";
import { CLARIFICATION_QUESTION } from "@/lib/chat/clarify";

const mAccounts = vi.mocked(getAccounts);
const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

const PROJECTS: FirestoreDoc[] = [
  { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
  { id: "F_7101", project_name: "Solbråveien", project_number: "7101" },
];

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  cap.reply = "Et svar fra modellen.";
  mAccounts.mockResolvedValue([]);
  mProjects.mockResolvedValue(PROJECTS);
  mGetEndreClient.mockReturnValue(null);
});

// --- A / I: vague opener in a new chat must clarify ------------------------
describe("A/I — vague opener in a new chat clarifies", () => {
  const vague = [
    "Gi meg det du har frem til september 2026",
    "Hva er kontraktsverdien?",
    "Vis det",
    "Hva er status?",
    "Hva har vi?",
  ];

  for (const message of vague) {
    it(`clarifies "${message}" without touching any data source`, async () => {
      const r = await runChat(message, "req", []);

      expect(r.route).toBe("clarification");
      expect(r.answer).toBe(CLARIFICATION_QUESTION);
      expect(r.diagnostics?.clarificationRequired).toBe(true);

      // No retrieval at all.
      expect(mProjects).not.toHaveBeenCalled();
      expect(mAccounts).not.toHaveBeenCalled();
      expect(mGetEndreClient).not.toHaveBeenCalled();
      expect(cap.inputs).toHaveLength(0); // the model was never called
      expect(r.sources).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(r.dataUsed.firestoreCollections).toEqual([]);

      // No concrete project leaked into the answer.
      expect(r.answer).not.toMatch(/pilestredet|solbr|afbo nora/i);
    });
  }
});

// --- self-sufficient questions in a new chat are NOT clarified -------------
describe("self-sufficient questions answer normally in a new chat", () => {
  it("'Hvilke prosjekter finnes?' routes to project_list, not clarification", async () => {
    const r = await runChat("Hvilke prosjekter finnes?", "req", []);
    expect(r.route).toBe("project_list");
    expect(mProjects).toHaveBeenCalled();
  });

  it("'Hva er kontraktsverdien på Pilestredet?' resolves the project, not clarification", async () => {
    const r = await runChat("Hva er kontraktsverdien på Pilestredet?", "req", []);
    expect(r.route).not.toBe("clarification");
    expect(r.diagnostics?.resolvedProjectNumber).toBe("7100");
  });
});

// --- same-chat context defeats the clarification gate ----------------------
describe("vague follow-up WITH relevant context is answered", () => {
  it("'Hva er kontraktsverdien?' after a 7100 summary is not clarified", async () => {
    const history = [
      { role: "user" as const, content: "Oppsummer prosjekt 7100" },
      {
        role: "assistant" as const,
        content:
          "Prosjektnavn: Pilestredet\nProsjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
      },
    ];
    const r = await runChat("Hva er kontraktsverdien?", "req", history);
    expect(r.route).not.toBe("clarification");
    expect(r.answer).toContain("150 705 668 kr");
  });
});
