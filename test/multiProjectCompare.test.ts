/**
 * Multi-project comparison (#2 / #15): "Sammenlign prosjekt 7100 og 3025. Hva vet du sikkert om begge, og hva mangler du data på?" must
 * gather EACH project on its own source (7100 from Firestore, 3025 from Endre)
 * and hand the model one block per project — never confusing the two nor
 * conflating Endre beløpsposter with local metrics.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EndreClient } from "@/lib/endre/client";

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

const cap = vi.hoisted(() => ({ inputs: [] as { systemPrompt: string; userPrompt: string }[] }));
vi.mock("@/lib/llm", () => ({
  getLLMProvider: () => ({
    name: "test",
    generateAnswer: async (input: { systemPrompt: string; userPrompt: string }) => {
      cap.inputs.push(input);
      return "Et svar.";
    },
  }),
}));

vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async () => [],
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));
vi.mock("@/lib/endre/client", () => ({ getEndreClient: vi.fn() }));
vi.mock("@/lib/documents/store", () => ({ getStructuredTables: async () => [] }));

import { runChat } from "@/lib/chat/orchestrator";
import { getProjects } from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";

const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

function endreClient(projects: unknown[]): EndreClient {
  const reject = () => Promise.reject(new Error("unused"));
  return {
    listProjects: () => Promise.resolve(projects),
    getProject: reject,
    getProjectAmounts: () => Promise.resolve([{ TotalAmount: 22938804.4, accepted: 15005294.18 }]),
    listProjectCases: reject,
    listProjectContracts: reject,
    getProjectTags: reject,
    listProjectOrganizations: reject,
  } as unknown as EndreClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  cap.inputs.length = 0;
  // 7100 lives in Firestore (full metrics); 3025 only in Endre.
  mProjects.mockResolvedValue([
    {
      id: "F_7100",
      project_number: "7100",
      project_name: "Pilestredet",
      kontraktsverdi: 150705668,
      forventet_resultat: 21441056,
    },
  ]);
  mGetEndreClient.mockReturnValue(
    endreClient([{ id: "E-3025", project_number: 3025, project_name: "AFBO NORA" }]),
  );
});

describe("multi-project comparison", () => {
  it("gathers both projects, each from its own source", async () => {
    const r = await runChat("Sammenlign prosjekt 7100 og 3025. Hva vet du sikkert om begge, og hva mangler du data på?", "req", []);
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // Both projects present, not confused.
    expect(userPrompt).toContain("7100");
    expect(userPrompt).toContain("Pilestredet");
    expect(userPrompt).toContain("3025");
    expect(userPrompt).toContain("AFBO NORA");
    // Each carries its own source label.
    expect(userPrompt).toContain("firebase");
    expect(userPrompt).toContain("endre");
    // The compareProjects tool ran.
    expect(r.diagnostics?.toolsRun?.some((t) => t.tool === "compareProjects")).toBe(true);
  });

  it("instructs the model not to conflate Endre totals with local metrics", async () => {
    await runChat("Sammenlign prosjekt 7100 og 3025. Hva vet du sikkert om begge, og hva mangler du data på?", "req", []);
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).toMatch(/Sammenlign KUN felter som finnes i samme prosjekt/i);
    expect(userPrompt).toMatch(/kall dem aldri «kontraktsverdi»/i);
  });

  it("flags a referenced project that was not found", async () => {
    const r = await runChat("Sammenlign prosjekt 7100 og 9999", "req", []);
    // Only 7100 resolves (Firestore); 9999 is nowhere → still single? compare needs >=2.
    // With only one found, multi mode does not take over; compareProjects runs with partial.
    const run = r.diagnostics?.toolsRun?.find((t) => t.tool === "compareProjects");
    expect(run?.coverage).toBe("partial");
  });

  it("a single-project question is unaffected (no compare_projects)", async () => {
    const r = await runChat("Oppsummer prosjekt 7100", "req", []);
    expect((r.diagnostics?.toolsRun ?? []).some((t) => t.tool === "compareProjects")).toBe(false);
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).not.toContain("compare_projects");
  });
});
