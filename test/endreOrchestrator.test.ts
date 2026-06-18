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

// Capture the prompts the model would receive; return a fixed answer.
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

// No document store/Firestore hit from the RAG layer.
vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async () => [],
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));

// The Endre client factory is mocked; each test decides what it returns.
vi.mock("@/lib/endre/client", () => ({
  getEndreClient: vi.fn(),
}));

import { runChat } from "@/lib/chat/orchestrator";
import { getProjects } from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";
import type { EndreClient } from "@/lib/endre/client";

const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

const FIRESTORE_PROJECTS: FirestoreDoc[] = [
  { id: "F_AAA111", project_name: "Pilestredet", project_number: "7100" },
];

const ENDRE_PROJECTS = [
  { id: "E-1", project_number: 7100, project_name: "Pilestredet (Endre)" },
];

function fakeEndreClient(
  overrides: Partial<Record<keyof EndreClient, unknown>>,
): EndreClient {
  const reject = () => Promise.reject(new Error("unused in test"));
  return {
    listProjects: () => Promise.resolve(ENDRE_PROJECTS),
    getProject: reject,
    getProjectAmounts: () => Promise.resolve([{ amount: 100 }]),
    listProjectCases: reject,
    listProjectContracts: reject,
    getProjectTags: reject,
    listProjectOrganizations: reject,
    ...overrides,
  } as unknown as EndreClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  mProjects.mockResolvedValue(FIRESTORE_PROJECTS);
});

describe("orchestrator — Endre disabled", () => {
  it("makes no Endre calls and answers from Firestore", async () => {
    mGetEndreClient.mockReturnValue(null); // flag off / creds missing

    const r = await runChat("Oppsummer prosjekt 7100", "req");

    // Falls back to Firestore projects; no Endre source is reported.
    expect(mProjects).toHaveBeenCalledTimes(1);
    expect(r.sources).toContain("projects");
    expect(r.sources.some((s) => s.startsWith("Endre API:"))).toBe(false);
  });
});

describe("orchestrator — Endre enabled", () => {
  it("uses Endre for a project summary and skips the Firestore project fetch", async () => {
    const listSpy = vi.fn(() => Promise.resolve(ENDRE_PROJECTS));
    mGetEndreClient.mockReturnValue(fakeEndreClient({ listProjects: listSpy }));

    const r = await runChat("Oppsummer prosjekt 7100", "req");

    expect(listSpy).toHaveBeenCalled();
    // Endre is preferred → Firestore projects are not fetched.
    expect(mProjects).not.toHaveBeenCalled();
    expect(r.sources).toContain("Endre API: projects");
    expect(r.sources).toContain("Endre API: project_amounts");
    // The Endre project block reaches the model context.
    expect(cap.inputs.at(-1)!.userPrompt).toContain("endre_project");
  });
});

describe("orchestrator — Endre failure falls back safely", () => {
  it("falls back to Firestore when Endre throws, with no Endre sources", async () => {
    mGetEndreClient.mockReturnValue(
      fakeEndreClient({ listProjects: () => Promise.reject(new Error("down")) }),
    );

    const r = await runChat("Oppsummer prosjekt 7100", "req");

    // Endre failed → Firestore answered instead.
    expect(mProjects).toHaveBeenCalledTimes(1);
    expect(r.sources).toContain("projects");
    expect(r.sources.some((s) => s.startsWith("Endre API:"))).toBe(false);
    // The answer still comes back normally.
    expect(r.answer).toBe("ok");
  });
});
