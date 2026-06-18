/**
 * Regression tests for the context-isolation rework (spec cases A–H).
 *
 * These pin the fixes for the failures where the assistant mixed context between
 * projects (citing accounts on a project metric, borrowing one project's value
 * for another, inventing a project number from an account number) and reversed
 * Norwegian time ranges ("frem til september").
 *
 * runChat is exercised with Firestore, the LLM, document search, the Endre
 * client and the structured-table store all mocked, so the assertions are about
 * the app's deterministic reasoning, not the model's wording.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirestoreDoc } from "@/lib/firestore/types";
import type { StoredStructuredTable } from "@/lib/documents/types";

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
  // The LLM answer the mock returns; tests can override per case.
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

const store = vi.hoisted(() => ({
  tables: [] as StoredStructuredTable[],
}));
vi.mock("@/lib/documents/store", () => ({
  getStructuredTables: async () => store.tables,
}));

import { runChat } from "@/lib/chat/orchestrator";
import { getAccounts, getProjects } from "@/lib/firestore/service";
import { getEndreClient } from "@/lib/endre/client";
import type { EndreClient } from "@/lib/endre/client";

const mAccounts = vi.mocked(getAccounts);
const mProjects = vi.mocked(getProjects);
const mGetEndreClient = vi.mocked(getEndreClient);

/** A chart of accounts long enough to trigger the truncation warning. */
const BIG_CHART: FirestoreDoc[] = Array.from({ length: 65 }, (_, i) => ({
  id: `a${i}`,
  number: String(6000 + i),
  name: `Konto ${i}`,
}));

const PILESTREDET_HISTORY = [
  { role: "user" as const, content: "Oppsummer prosjekt 7100" },
  {
    role: "assistant" as const,
    content:
      "Prosjektnavn: Pilestredet\nProsjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
  },
];

/** Endre client returning a fixed project list; amounts present, others reject. */
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
  cap.reply = "Et svar fra modellen.";
  store.tables = [];
  mAccounts.mockResolvedValue([]);
  mProjects.mockResolvedValue([
    { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
    { id: "F_7101", project_name: "Solbråveien", project_number: "7101" },
  ]);
  mGetEndreClient.mockReturnValue(null);
});

// --- A: project_metric source pruning --------------------------------------
describe("A — project metric never cites accounts", () => {
  it("answers kontraktsverdi from history without an accounts source or warning", async () => {
    // A full chart is present, but a metric follow-up must not pull it in.
    mAccounts.mockResolvedValue(BIG_CHART);

    const r = await runChat("Hva er kontraktsverdien?", "req", PILESTREDET_HISTORY);

    expect(r.answer).toContain("150 705 668 kr");
    expect(r.diagnostics?.resolvedProjectNumber).toBe("7100");
    // No accounts anywhere.
    expect(r.sources).not.toContain("accounts");
    expect(r.dataUsed.firestoreCollections).not.toContain("accounts");
    // No account-truncation warning leaked onto a project answer.
    expect(r.warnings.join(" ")).not.toMatch(/kontoer/i);
    // Allowed sources only.
    expect(r.sources).toContain("projects");
    // Accounts were never even fetched (route does not allow them).
    expect(mAccounts).not.toHaveBeenCalled();
  });
});

// --- B: cross-project metric isolation -------------------------------------
describe("B — no cross-project metric leakage", () => {
  const CROSS_HISTORY = [
    ...PILESTREDET_HISTORY,
    { role: "user" as const, content: "Oppsummer prosjekt 3025" },
    {
      role: "assistant" as const,
      content: "Prosjektnavn: AFBO NORA\nProsjektnummer: 3025",
    },
  ];

  it("does not reuse Pilestredet's value for AFBO NORA when 3025 has no contract field", async () => {
    // Endre knows AFBO NORA/3025 but the record carries no contract value.
    mGetEndreClient.mockReturnValue(
      endreClient([{ id: "E-3025", project_number: 3025, project_name: "AFBO NORA" }]),
    );
    cap.reply =
      "Jeg finner AFBO NORA (prosjekt 3025) i Endre, men ikke et eget felt for kontraktsverdi.";

    const r = await runChat(
      "Hva er kontraktsverdien på AFBO NORA?",
      "req",
      CROSS_HISTORY,
    );

    expect(r.diagnostics?.resolvedProjectNumber).toBe("3025");
    // The deterministic path must NOT fire with a borrowed/invented value.
    expect(r.diagnostics?.deterministicAnswerUsed).toBe(false);
    // Neither the wrong borrowed value nor the project number as money.
    expect(r.answer).not.toContain("150 705 668");
    expect(r.answer).not.toMatch(/7\s?100\s*kr/);
    expect(r.sources).not.toContain("accounts");
  });

  it("answers AFBO NORA's own contract value when Endre provides it", async () => {
    const endre = endreClient([
      {
        id: "E-3025",
        project_number: 3025,
        project_name: "AFBO NORA",
        contract_value: 42000000,
      },
    ]);
    mGetEndreClient.mockReturnValue(endre);

    const r = await runChat(
      "Hva er kontraktsverdien på AFBO NORA?",
      "req",
      CROSS_HISTORY,
    );

    expect(r.diagnostics?.resolvedProjectNumber).toBe("3025");
    expect(r.diagnostics?.deterministicAnswerUsed).toBe(true);
    expect(r.answer).toContain("42 000 000 kr");
    // Only AFBO NORA's value — never Pilestredet's.
    expect(r.answer).not.toContain("150 705 668");
  });
});

// --- D/E: staffing invents no project, excludes accounts -------------------
describe("D/E — staffing question invents no project and excludes accounts", () => {
  const STAFFING_HISTORY = [
    {
      role: "user" as const,
      content: "Hva fører jeg arbeidshansker på?",
    },
    {
      role: "assistant" as const,
      content: "Du fører arbeidshansker på konto 6940 (Verktøy og verneutstyr).",
    },
  ];

  it("does not turn account number 6940 into 'prosjekt 6940' and skips accounts", async () => {
    const r = await runChat(
      "Vi starter nytt prosjekt i august. ca 29.000 timer. Fordeling 30% Stilfixer, " +
        "60% Carpenter og resterende welder. Har vi kapasitet til å ta prosjektet " +
        "eller trenger vi flere folk?",
      "req",
      STAFFING_HISTORY,
    );

    expect(r.route).toBe("staffing_capacity");
    // No project number was invented from the account number in history.
    expect(r.diagnostics?.resolvedProjectNumber).toBeNull();
    // The prompt the model sees must not contain "prosjekt 6940".
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).not.toMatch(/prosjekt 6940/i);
    // Accounts and projects are excluded entirely.
    expect(mAccounts).not.toHaveBeenCalled();
    expect(mProjects).not.toHaveBeenCalled();
    expect(r.sources).not.toContain("accounts");
  });
});

// --- F: 'frem til september 2026' month range ------------------------------
describe("F — monthly capacity honours 'frem til september 2026'", () => {
  function monthRow(month: string, hours: number): StoredStructuredTable {
    return {
      documentId: "D1",
      documentName: "bemanningsplan.xlsx",
      sheetName: "Kapasitet",
      columns: {},
      rows: [
        {
          month,
          role: "Carpenter",
          rawRole: "Carpenter",
          availableHours: hours,
          assignedHours: null,
          person: null,
        },
      ],
    };
  }

  beforeEach(() => {
    store.tables = [
      monthRow("januar 2026", 100),
      monthRow("august 2026", 200),
      monthRow("september 2026", 300),
      monthRow("oktober 2026", 400),
      monthRow("november 2026", 500),
      monthRow("desember 2026", 600),
    ];
  });

  it("includes months up to September and excludes Oct–Dec", async () => {
    const r = await runChat(
      "Gi meg det du har frem til september 2026",
      "req",
      [
        {
          role: "user",
          content: "Kan du gi meg tilgjengelig kapasitet hver måned ut året?",
        },
        { role: "assistant", content: "Her er kapasiteten per måned …" },
      ],
    );

    expect(r.route).toBe("monthly_capacity");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // Through September is present...
    expect(userPrompt).toContain("september 2026");
    expect(userPrompt).toContain("august 2026");
    // ...October–December are filtered out before the model ever sees them.
    expect(userPrompt).not.toContain("oktober 2026");
    expect(userPrompt).not.toContain("november 2026");
    expect(userPrompt).not.toContain("desember 2026");
    // No phantom "prosjekt 2026".
    expect(userPrompt).not.toMatch(/prosjekt 2026/i);
  });
});

// --- account lookup + project list still work ------------------------------
describe("regression — existing routes still work", () => {
  it("account lookup still resolves to account 6570", async () => {
    mAccounts.mockResolvedValue([
      { id: "a1", number: "6570", name: "Driftsmateriell og verneutstyr" },
      { id: "a2", number: "7140", name: "Reisekostnad" },
    ]);
    const r = await runChat("Hva fører jeg arbeidshansker på?", "req");
    expect(r.diagnostics?.intent).toBe("account_lookup");
    expect(r.dataUsed.firestoreCollections).toContain("accounts");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).toContain("6570");
  });

  it("project list still returns 3025, 7100 and 7101", async () => {
    mProjects.mockResolvedValue([
      { id: "F_7100", project_name: "Pilestredet", project_number: "7100" },
      { id: "F_7101", project_name: "Solbråveien", project_number: "7101" },
    ]);
    mGetEndreClient.mockReturnValue(
      endreClient([{ id: "E-3025", project_number: 3025, project_name: "AFBO NORA" }]),
    );
    const r = await runChat("Hvilke prosjekter finnes?", "req");
    expect(r.route).toBe("project_list");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    for (const token of ["3025", "7100", "7101"]) {
      expect(userPrompt).toContain(token);
    }
  });
});
