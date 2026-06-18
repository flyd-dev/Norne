/**
 * End-to-end regression tests for the reasoning rework (spec cases A–H).
 *
 * Exercises runChat with the LLM, document search and (where relevant) the Endre
 * client mocked, asserting the assistant resolves references, picks the right
 * source and answers known values deterministically instead of refusing.
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
}));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "test",
    // The LLM "forgets" and refuses — the app layer must still answer correctly.
    generateAnswer: async (input: { systemPrompt: string; userPrompt: string }) => {
      cap.inputs.push(input);
      return "Jeg har ikke nok informasjon til å svare på det.";
    },
  }),
}));

vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async () => [],
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));

vi.mock("@/lib/endre/client", () => ({ getEndreClient: vi.fn() }));

import { runChat } from "@/lib/chat/orchestrator";
import {
  getAccounts,
  getProjects,
} from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";
import type { EndreClient } from "@/lib/endre/client";

const mAccounts = vi.mocked(getAccounts);
const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

const PILESTREDET_HISTORY = [
  { role: "user" as const, content: "Oppsummer prosjekt 7100" },
  {
    role: "assistant" as const,
    content:
      "Prosjektnavn: Pilestredet\nProsjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
  },
];

function endreClient(projects: unknown[]): EndreClient {
  const reject = () => Promise.reject(new Error("unused"));
  return {
    listProjects: () => Promise.resolve(projects),
    getProject: reject,
    getProjectAmounts: () => Promise.resolve([{ amount: 100 }]),
    listProjectCases: reject,
    listProjectContracts: reject,
    getProjectTags: reject,
    listProjectOrganizations: reject,
  } as unknown as EndreClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  mAccounts.mockResolvedValue([]);
  mProjects.mockResolvedValue([
    { id: "F_AAA111", project_name: "Pilestredet", project_number: "7100" },
    { id: "F_BBB222", project_name: "Skaidi", project_number: "7200" },
  ]);
  mGetEndreClient.mockReturnValue(null);
});

describe("A — named-project metric from history", () => {
  it("answers contract value for Pilestredet from prior context, not 'ikke nok informasjon'", async () => {
    const r = await runChat(
      "Hva er total kontraktsverdi på Pilestredet prosjektet?",
      "req",
      PILESTREDET_HISTORY,
    );
    expect(r.answer).toContain("150 705 668 kr");
    expect(r.answer).toContain("Pilestredet");
    expect(r.answer).toContain("7100");
    expect(r.answer).not.toMatch(/ikke nok informasjon/i);
    expect(r.diagnostics?.deterministicAnswerUsed).toBe(true);
    expect(r.diagnostics?.resolvedMetric).toBe("contract_value");
    // Endre is not the sole source.
    expect(r.sources).not.toEqual(["Endre API: projects"]);
    expect(r.sources).toContain("projects");
  });
});

describe("B — typo in the metric", () => {
  it("resolves 'kongraksverdi' to contract value and answers", async () => {
    const r = await runChat(
      "Hva er total kongraksverdi på Pilestredet prosjektet?",
      "req",
      PILESTREDET_HISTORY,
    );
    expect(r.answer).toContain("150 705 668 kr");
    expect(r.diagnostics?.resolvedMetric).toBe("contract_value");
  });
});

describe("C — elliptical follow-up reuses prior project", () => {
  it("answers 'Hva er kontraktsverdien?' using project 7100 from history", async () => {
    const r = await runChat("Hva er kontraktsverdien?", "req", PILESTREDET_HISTORY);
    expect(r.answer).toContain("150 705 668 kr");
    expect(r.diagnostics?.resolvedProjectNumber).toBe("7100");
  });
});

describe("D — project that exists in Endre", () => {
  it("uses Endre and skips Firestore for project 3025", async () => {
    mGetEndreClient.mockReturnValue(
      endreClient([{ id: "E-3025", project_number: 3025, project_name: "AFBO NORA" }]),
    );
    const r = await runChat("Oppsummer prosjekt 3025", "req");
    expect(r.sources).toContain("Endre API: projects");
    expect(mProjects).not.toHaveBeenCalled();
  });
});

describe("E — number not in Endre falls back to Firestore", () => {
  it("checks Endre but answers project 7100 from Firestore (no kontoplan)", async () => {
    mGetEndreClient.mockReturnValue(
      endreClient([{ id: "E-3025", project_number: 3025, project_name: "AFBO NORA" }]),
    );
    const r = await runChat("Oppsummer prosjekt 7100", "req");
    expect(mProjects).toHaveBeenCalled();
    expect(r.sources).toContain("projects");
    expect(r.sources.some((s) => s.startsWith("Endre API:"))).toBe(false);
    expect(r.sources).not.toContain("accounts");
  });
});

describe("F — named project missing from Endre must not answer only from Endre", () => {
  it("falls back to Firestore for Pilestredet's contract value", async () => {
    mProjects.mockResolvedValue([
      {
        id: "F_AAA111",
        project_name: "Pilestredet",
        project_number: "7100",
        contract_value: 150705668,
      },
    ]);
    mGetEndreClient.mockReturnValue(
      endreClient([{ id: "E-3025", project_number: 3025, project_name: "AFBO NORA" }]),
    );
    const r = await runChat(
      "Hva er total kontraktsverdi på Pilestredet prosjektet?",
      "req",
    );
    expect(r.answer).toContain("150 705 668 kr");
    expect(r.sources).toContain("projects");
    expect(r.sources).not.toEqual(["Endre API: projects"]);
    expect(r.sources.some((s) => s.startsWith("Endre API:"))).toBe(false);
  });
});

describe("G — account question is unaffected by entity/metric resolution", () => {
  it("still routes 'Hvor fører jeg arbeidshansker?' to accounts, not projects", async () => {
    mAccounts.mockResolvedValue([
      { id: "a2", number: "6570", name: "Driftsmateriell og verneutstyr" },
    ]);
    const r = await runChat("Hvor fører jeg arbeidshansker?", "req");
    expect(r.dataUsed.firestoreCollections).toContain("accounts");
    expect(r.dataUsed.firestoreCollections).not.toContain("projects");
    expect(r.diagnostics?.intent).toBe("account_lookup");
    expect(mProjects).not.toHaveBeenCalled();
  });
});

describe("Project list — combines Endre + Firestore/local projects", () => {
  it("lists 3025 (Endre) plus 7100 and 7101 (Firestore), citing both sources", async () => {
    mProjects.mockResolvedValue([
      { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
      { id: "F_7101", project_name: "Solbråveien", project_number: "7101" },
    ]);
    mGetEndreClient.mockReturnValue(
      endreClient([{ id: "E-3025", project_number: 3025, project_name: "AFBO NORA" }]),
    );

    const r = await runChat("Hvilke prosjekter finnes?", "req");

    expect(r.route).toBe("project_list");
    // Both sources contribute and are cited.
    expect(r.sources).toContain("Endre API: projects");
    expect(r.sources).toContain("projects");
    // No account truncation warning on a project-list question.
    expect(r.warnings.join(" ")).not.toMatch(/kontoer/i);
    expect(r.diagnostics?.accountWarningsPruned).toBeUndefined();
    // Counts reflect the combine + dedupe.
    expect(r.diagnostics?.endreProjectCount).toBe(1);
    expect(r.diagnostics?.firestoreProjectCount).toBe(2);
    expect(r.diagnostics?.combinedProjectCount).toBe(3);
    // All three projects reach the model context.
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    for (const token of ["3025", "AFBO NORA", "7100", "Pilestredet", "7101", "Solbråveien"]) {
      expect(userPrompt).toContain(token);
    }
    // Internal ids are not surfaced.
    expect(userPrompt).not.toContain("F_7100");
    expect(userPrompt).not.toContain("E-3025");
  });

  it("falls back to Firestore-only when Endre is unavailable", async () => {
    mProjects.mockResolvedValue([
      { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
    ]);
    mGetEndreClient.mockReturnValue(null);

    const r = await runChat("Vis alle prosjekter", "req");

    expect(r.route).toBe("project_list");
    expect(r.sources).toContain("projects");
    expect(r.sources.some((s) => s.startsWith("Endre API:"))).toBe(false);
    expect(r.diagnostics?.endreProjectCount).toBe(0);
    expect(r.diagnostics?.firestoreProjectCount).toBe(1);
  });
});

describe("H — capacity question is unaffected", () => {
  it("routes a capacity question to staffing_capacity without the deterministic path", async () => {
    const r = await runChat(
      "Vi skal starte nytt prosjekt i august. Ca. 29.000 timer. Fordeling 30% Welder, 20% Stilfixer og resterende Carpenter. Har vi kapasitet?",
      "req",
    );
    expect(r.route).toBe("staffing_capacity");
    expect(r.diagnostics?.deterministicAnswerUsed).toBe(false);
    expect(mProjects).not.toHaveBeenCalled();
    expect(mAccounts).not.toHaveBeenCalled();
  });
});
