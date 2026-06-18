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

// Mock document search so the orchestrator does not hit the store/Firestore.
const docs = vi.hoisted(() => ({
  matches: [] as {
    documentId: string;
    documentName: string;
    fileType: string;
    sheetName?: string;
    chunkIndex: number;
    text: string;
    score: number;
  }[],
}));
const searchCalls = vi.hoisted(() => ({
  args: [] as { query: string; opts: unknown }[],
}));
vi.mock("@/lib/rag/documentSearch", () => ({
  searchDocuments: async (query: string, opts: unknown) => {
    searchCalls.args.push({ query, opts });
    return docs.matches;
  },
  MAX_DOCUMENT_MATCHES: 6,
  MAX_CAPACITY_MATCHES: 16,
}));

import { runChat } from "@/lib/chat/orchestrator";
import { CAPABILITIES_ANSWER } from "@/lib/chat/capabilities";
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
  docs.matches = [];
  searchCalls.args.length = 0;
  mProjects.mockResolvedValue(PROJECTS);
  mAccounts.mockResolvedValue([]);
  mBudget.mockResolvedValue([
    { id: "b1", cost: 100 },
    { id: "b2", cost: 250 },
  ]);
  mQty.mockResolvedValue([{ id: "q1", amount: 5 }]);
});

describe("runChat — meta/capabilities short-circuit", () => {
  it("answers 'Hva kan du gjøre?' deterministically without any retrieval", async () => {
    const r = await runChat("Hva kan du gjøre?", "req");
    expect(r.route).toBe("capabilities_help");
    expect(r.answer).toBe(CAPABILITIES_ANSWER);
    // No data sources, no warnings, no documents.
    expect(r.sources).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.dataUsed.firestoreCollections).toEqual([]);
    expect(r.dataUsed.documents).toEqual([]);
    // Nothing was fetched and the LLM was never called.
    expect(mProjects).not.toHaveBeenCalled();
    expect(mAccounts).not.toHaveBeenCalled();
    expect(searchCalls.args.length).toBe(0);
    expect(cap.inputs.length).toBe(0);
    expect(r.diagnostics?.intent).toBe("capabilities_help");
  });

  it("does not inherit history for a meta question", async () => {
    const r = await runChat("Hjelp", "req", [
      { role: "user", content: "Oppsummer prosjekt 7100" },
      {
        role: "assistant",
        content: "Prosjektnavn: Pilestredet\nKontraktsverdi: 150 705 668 kr",
      },
    ]);
    expect(r.route).toBe("capabilities_help");
    expect(r.diagnostics?.resolvedProjectNumber).toBeNull();
    expect(cap.inputs.length).toBe(0);
  });
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

  it("instructs the model not to add unsupported conclusions to list answers", async () => {
    await runChat("Hvilke prosjekter finnes?", "req");
    const sys = cap.inputs.at(-1)!.systemPrompt;
    // No inferring status/contract value/activity unless explicitly in context.
    expect(sys).toMatch(/Ikke utled eller anta status, kontraktsverdi/i);
    // List questions: only list items/fields present in context.
    expect(sys).toMatch(/For listespørsmål/i);
    // No trailing generic summaries.
    expect(sys).toContain(
      "Ikke avslutt med generelle oppsummeringer som ikke direkte støttes av konteksten.",
    );
  });

  it("instructs the model to use names/numbers and hide ids unless asked", async () => {
    await runChat("Hvilke prosjekter finnes?", "req");
    const sys = cap.inputs.at(-1)!.systemPrompt;
    // Project lists should show name + number.
    expect(sys).toMatch(/vis prosjektnavn og prosjektnummer/i);
    // Internal document ids hidden unless explicitly requested.
    expect(sys).toMatch(/Ikke vis interne dokument-ID-er.*med mindre brukeren/is);
  });

  it("omits internal document ids from context but keeps name + number", async () => {
    await runChat("Hvilke prosjekter finnes?", "req");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).not.toContain("P_AAA111"); // internal id must not leak
    expect(userPrompt).toContain("Pilestredet"); // name present
    expect(userPrompt).toContain("7100"); // project number present
  });

  it("includes ids in context only when the user explicitly asks for id", async () => {
    await runChat("Hvilke prosjekter finnes? Vis prosjekt-id.", "req");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).toContain("P_AAA111");
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

  it("includes document chunks in context and references in dataUsed", async () => {
    docs.matches = [
      {
        documentId: "DOC1",
        documentName: "bemanningsplan.xlsx",
        fileType: "xlsx",
        sheetName: "Bemanning",
        chunkIndex: 2,
        text: "Bemanning uke 12: Kari og Ola.",
        score: 5,
      },
    ];

    const r = await runChat("Hvem er på bemanning uke 12?", "req");

    // The chunk TEXT reaches the model context...
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).toContain("Bemanning uke 12: Kari og Ola.");

    // ...but the client only gets compact references (no chunk text), and the
    // document name appears in sources.
    expect(r.dataUsed.documents).toEqual([
      {
        documentId: "DOC1",
        documentName: "bemanningsplan.xlsx",
        fileType: "xlsx",
        sheetName: "Bemanning",
        chunkIndex: 2,
      },
    ]);
    expect(r.sources).toContain("bemanningsplan.xlsx");
    expect(Array.isArray(r.dataUsed.firestoreCollections)).toBe(true);
  });

  it("includes the document grounding rules in the system prompt", async () => {
    await runChat("Hvem er på bemanning?", "req");
    const sys = cap.inputs.at(-1)!.systemPrompt;
    expect(sys).toMatch(/opplastet dokument/i);
    expect(sys).toMatch(/inkonsistent/i);
  });

  it("system prompt forbids explaining raw JSON/context", async () => {
    await runChat("Hvilke prosjekter finnes?", "req");
    const sys = cap.inputs.at(-1)!.systemPrompt;
    expect(sys).toMatch(/Forklar aldri den rå konteksten/i);
    expect(sys).toMatch(/JSON/);
  });
});

describe("runChat — account-lookup questions", () => {
  beforeEach(() => {
    mAccounts.mockResolvedValue([
      { id: "a1", number: "4000", name: "Varekjøp" },
      { id: "a2", number: "6570", name: "Driftsmateriell og verneutstyr" },
      { id: "a3", number: "7140", name: "Reisekostnad" },
    ]);
  });

  it("treats 'Hva fører jeg arbeidshansker på?' as an account lookup", async () => {
    const r = await runChat("Hva fører jeg arbeidshansker på?", "req");
    // Accounts collection is used...
    expect(r.dataUsed.firestoreCollections).toContain("accounts");
    // ...and projects are NOT pulled in for an account question.
    expect(r.dataUsed.firestoreCollections).not.toContain("projects");
    expect(mProjects).not.toHaveBeenCalled();
  });

  it("sends only the relevant accounts, not the whole chart", async () => {
    await runChat("Hva fører jeg arbeidshansker på?", "req");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // The matching verneutstyr account is included...
    expect(userPrompt).toContain("6570");
    expect(userPrompt).toContain("verneutstyr");
    // ...unrelated accounts are filtered out.
    expect(userPrompt).not.toContain("Reisekostnad");
  });

  it("instructs the model not to invent account numbers", async () => {
    await runChat("Hva fører jeg arbeidshansker på?", "req");
    const last = cap.inputs.at(-1)!;
    // Both the system prompt and the per-question note forbid invention.
    expect(last.systemPrompt).toMatch(/aldri finn på et kontonummer/i);
    expect(last.userPrompt).toMatch(/aldri finn på et kontonummer/i);
    // Only account numbers that exist in context appear in the prompt; no
    // fabricated numbers are introduced by the pipeline.
    expect(last.userPrompt).not.toContain("9999");
  });

  it("account-lookup answers do not include project context", async () => {
    await runChat("Hvilken konto bruker jeg for arbeidshansker?", "req");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).not.toContain("Pilestredet");
    expect(userPrompt).not.toContain("Skaidi");
    expect(userPrompt).not.toContain('"projects"');
  });
});

describe("runChat — account-list questions", () => {
  it("routes 'Hvilke kontoer finnes?' to account_list using the accounts source", async () => {
    mAccounts.mockResolvedValue([
      { id: "a1", number: "4000", name: "Varekjøp" },
      { id: "a2", number: "6570", name: "Driftsmateriell og verneutstyr" },
    ]);
    const r = await runChat("Hvilke kontoer finnes?", "req");
    expect(r.route).toBe("account_list");
    expect(r.dataUsed.firestoreCollections).toContain("accounts");
    // A short chart fits, so no truncation warning is emitted.
    expect(r.warnings.join(" ")).not.toMatch(/Viser kun/);
    // Projects are not dragged into an account-list answer.
    expect(mProjects).not.toHaveBeenCalled();
  });

  it("shows the truncation warning for 'Vis kontoplanen' only when truncated", async () => {
    // 65 accounts → more than the 50-item cap, so the list is genuinely truncated.
    mAccounts.mockResolvedValue(
      Array.from({ length: 65 }, (_, i) => ({
        id: `a${i}`,
        number: String(4000 + i),
        name: `Konto ${i}`,
      })),
    );
    const r = await runChat("Vis kontoplanen", "req");
    expect(r.route).toBe("account_list");
    expect(r.warnings.some((w) => /Viser kun 50 av 65 kontoer/.test(w))).toBe(true);
  });

  it("suppresses the account truncation warning on a non-account route", async () => {
    // A generic, keyword-free question falls back to projects+accounts; accounts
    // are incidental, so the "Viser kun …" warning must NOT appear.
    mAccounts.mockResolvedValue(
      Array.from({ length: 65 }, (_, i) => ({
        id: `a${i}`,
        number: String(4000 + i),
        name: `Konto ${i}`,
      })),
    );
    const r = await runChat("Hei, kan du fortelle meg litt?", "req");
    expect(r.route).not.toBe("account_list");
    expect(r.warnings.join(" ")).not.toMatch(/Viser kun/);
    expect(r.diagnostics?.accountWarningsPruned).toBe(true);
    // The incidental accounts source is pruned from the cited sources.
    expect(r.sources).not.toContain("accounts");
  });
});

describe("runChat — capacity / staffing questions", () => {
  const CAPACITY_Q =
    "Vi skal starte nytt prosjekt i august. Ca. 29.000 timer. Fordeling 30% Welder, 20% Stilfixer og resterende Carpenter. Har vi kapasitet eller må vi hente inn flere folk?";

  it("prioritizes the staffing plan and excludes the chart of accounts", async () => {
    await runChat(CAPACITY_Q, "req");
    // No Firestore account/project fetch for a capacity question.
    expect(mAccounts).not.toHaveBeenCalled();
    expect(mProjects).not.toHaveBeenCalled();
    // Document search is asked to boost bemanning and exclude the chart of accounts.
    const call = searchCalls.args.at(-1)!;
    const opts = call.opts as {
      limit: number;
      boostDocumentNames: string[];
      excludeDocumentNames: string[];
    };
    expect(opts.limit).toBe(16);
    expect(opts.boostDocumentNames).toContain("bemanning");
    expect(opts.excludeDocumentNames).toContain("kontoplan");
  });

  it("puts the deterministic demand breakdown in the prompt", async () => {
    await runChat(CAPACITY_Q, "req");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    // Demand breakdown 8 700 / 5 800 / 14 500 hours.
    expect(userPrompt).toContain("8 700");
    expect(userPrompt).toContain("5 800");
    expect(userPrompt).toContain("14 500");
    expect(userPrompt).toMatch(/bemanningsplanen/i);
  });

  it("includes structured capacity_demand in the model context", async () => {
    await runChat(CAPACITY_Q, "req");
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).toContain("capacity_demand");
    expect(userPrompt).toContain('"totalHours": 29000');
  });

  it("resolves the follow-up 'Du har bemanningsplanen. sjekk den' from history", async () => {
    await runChat("Du har bemanningsplanen. sjekk den", "req", [
      { role: "user", content: CAPACITY_Q },
      { role: "assistant", content: "Jeg har ikke nok informasjon …" },
    ]);
    // The follow-up was recognised as a capacity question via the prior turn.
    expect(mAccounts).not.toHaveBeenCalled();
    const call = searchCalls.args.at(-1)!;
    expect(call.query).toContain("29.000");
    const opts = call.opts as { boostDocumentNames: string[] };
    expect(opts.boostDocumentNames).toContain("bemanning");
    // Demand breakdown recovered from the prior question.
    const userPrompt = cap.inputs.at(-1)!.userPrompt;
    expect(userPrompt).toContain("8 700");
  });

  it("includes capacity and follow-up rules in the system prompt", async () => {
    await runChat("Har vi kapasitet i august?", "req");
    const sys = cap.inputs.at(-1)!.systemPrompt;
    expect(sys).toMatch(/bemanningsplan/i);
    expect(sys).toMatch(/sjekk den/i);
  });
});
