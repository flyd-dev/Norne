/**
 * Chatbot orchestrator.
 *
 * Pipeline:
 *   1. Detect which topics the question is about (accounts / projects / budget / qty).
 *   2. Retrieve ONLY the relevant Firestore data.
 *   3. Minimize data: normalize documents and aggregate large row sets before
 *      they ever reach the model.
 *   4. (Future) document/RAG search — placeholder, returns nothing today.
 *   5. Build a compact context, ask OpenAI to answer strictly from it.
 *
 * Designed so document/RAG retrieval slots in at step 4 without restructuring.
 */

import "server-only";
import {
  COLLECTIONS,
  getAccounts,
  getBudgetLines,
  getProjects,
  getQuantities,
} from "@/lib/firestore/service";
import type { FirestoreDoc } from "@/lib/firestore/types";
import {
  normalizeAccount,
  normalizeProject,
  summarizeRows,
} from "@/lib/firestore/normalize";
import { detectIntent } from "@/lib/chat/intent";
import { rankAccounts } from "@/lib/chat/accountLookup";
import { resolveProject } from "@/lib/chat/projectResolver";
import {
  searchDocuments,
  MAX_CAPACITY_MATCHES,
  type DocumentMatch,
} from "@/lib/rag/documentSearch";
import type { DocumentReference } from "@/lib/documents/types";
import { getStructuredTables } from "@/lib/documents/store";
import { getLLMProvider } from "@/lib/llm";
import { SYSTEM_PROMPT, buildUserPrompt } from "@/lib/chat/prompts";
import { logChatResolved, logEndreDiagnostics, logChatPlan } from "@/lib/logger";
import { endreReady } from "@/lib/env";
import {
  resolveFollowUp,
  type ChatHistoryMessage,
} from "@/lib/chat/followup";
import { planQuestion } from "@/lib/chat/questionPlanner";
import { resolveEntity } from "@/lib/chat/entityResolver";
import { extractHistoryFacts } from "@/lib/chat/historyFacts";
import { readMetricField } from "@/lib/chat/metricResolver";
import {
  buildProjectMetricAnswer,
  type MetricValueSource,
} from "@/lib/chat/projectMetricAnswer";
import { verifyAnswer, pruneSources } from "@/lib/chat/answerVerifier";
import { ALL_ROLE_TERMS } from "@/lib/chat/roles";
import {
  analyzeCapacity,
  formatCapacityNote,
  formatHours,
} from "@/lib/chat/capacityAnalysis";
import { routeMessage, type Route } from "@/lib/chat/router";
import {
  readStructuredAvailability,
  type StructuredAvailability,
} from "@/lib/chat/capacityStructured";
import { getEndreClient } from "@/lib/endre/client";
import {
  buildEndreProjectContext,
  listEndreProjects,
  dedupeProjects,
  type EndreDiagnostics,
  type ListedProject,
} from "@/lib/chat/endreSource";
import {
  CAPABILITIES_ANSWER,
  isCapabilitiesQuestion,
} from "@/lib/chat/capabilities";

/** Max top-level docs (accounts/projects) included in the model context. */
const MAX_ITEMS_PER_SOURCE = 50;

/** Max accounts sent for an account-lookup question (top relevant only). */
const MAX_LOOKUP_ACCOUNTS = 12;

/** Matches when the user explicitly asks for internal ids. */
const WANTS_IDS =
  /\b(id|ids|uid|prosjekt[\s-]?id|prosjektid|dokument[\s-]?id|dokumentid|document[\s-]?id)\b/i;

export interface ChatDataUsed {
  /** Firestore collection paths the answer is based on. */
  firestoreCollections: string[];
  /** References to document chunks used (no chunk text, for the client). */
  documents: DocumentReference[];
}

/** Safe, payload-free diagnostics about how the answer was produced. */
export interface ChatDiagnostics {
  intent: string;
  resolvedProjectNumber: string | null;
  resolvedProjectName: string | null;
  resolvedMetric: string | null;
  confidence: string;
  selectedSources: string[];
  checkedSources: string[];
  answerFound: boolean;
  deterministicAnswerUsed: boolean;
  fallbackReasons: string[];
  /** What the answer verifier did: "none" | "passed" | "replaced_deterministic". */
  verifierAction: string;
  /** Projects returned by Endre for a project_list question. */
  endreProjectCount?: number;
  /** Projects returned by Firestore/local data for a project_list question. */
  firestoreProjectCount?: number;
  /** Combined project count after the Endre+Firestore merge (project_list only). */
  combinedProjectCount?: number;
  /** True when an account truncation warning was suppressed on a non-account route. */
  accountWarningsPruned?: boolean;
}

export interface ChatResult {
  answer: string;
  /** All sources the answer draws on (collection paths + "documents"). */
  sources: string[];
  dataUsed: ChatDataUsed;
  /** Non-fatal notices (truncation, ambiguous/missing project, config mode). */
  warnings: string[];
  /** The route the question was classified into (for feedback + debugging). */
  route?: Route;
  /** Safe diagnostics about planning/resolution/source selection. */
  diagnostics?: ChatDiagnostics;
}

type ContextBlock = Record<string, unknown>;

export async function runChat(
  message: string,
  requestId: string,
  history: ChatHistoryMessage[] = [],
): Promise<ChatResult> {
  // --- Early meta / capabilities gate (runs FIRST, before any retrieval) -----
  // A "Hva kan du gjøre?"-style question is about the assistant itself, not about
  // company data. Answer deterministically and short-circuit: no follow-up
  // resolution, no history inheritance, no Endre/Firestore/accounts/documents,
  // no sources, no warnings. This is what stops a meta question from being
  // mishandled as a project/account lookup.
  if (isCapabilitiesQuestion(message)) {
    const diagnostics: ChatDiagnostics = {
      intent: "capabilities_help",
      resolvedProjectNumber: null,
      resolvedProjectName: null,
      resolvedMetric: null,
      confidence: "high",
      selectedSources: [],
      checkedSources: [],
      answerFound: true,
      deterministicAnswerUsed: true,
      fallbackReasons: [],
      verifierAction: "none",
    };
    logChatPlan(requestId, diagnostics);
    return {
      answer: CAPABILITIES_ANSWER,
      sources: [],
      dataUsed: { firestoreCollections: [], documents: [] },
      warnings: [],
      route: "capabilities_help",
      diagnostics,
    };
  }

  // Resolve short follow-ups ("sjekk den", "bruk bemanningsplanen") against the
  // most recent substantive question. Only the retrieval text is enriched; the
  // user still sees, and we still answer, the original message.
  const followUp = resolveFollowUp(message, history);
  const retrievalText = followUp.retrievalText;

  const intent = detectIntent(retrievalText);

  // Turn the intent into an explicit route with a fixed source/search/format
  // policy. The orchestrator obeys this instead of re-deriving rules inline.
  const decision = routeMessage(retrievalText, intent, followUp.isFollowUp);

  // Reasoning/planning layer: resolve the entity (project) and metric the user
  // really means, decide which sources are relevant, and whether history is
  // needed — BEFORE any retrieval. The orchestrator then obeys the plan.
  const plan = planQuestion({
    message,
    retrievalText,
    intent,
    decision,
    history,
    isFollowUp: followUp.isFollowUp,
  });
  const historyFacts = extractHistoryFacts(history);
  const endreHint = {
    projectNumber: plan.entities.projectNumber ?? null,
    projectName: plan.entities.projectName ?? null,
  };
  const fallbackReasons: string[] = [];
  let deterministicAnswerUsed = false;

  // project_list: combine Endre (live) + Firestore/local projects. Tracked here
  // so the counts can reach diagnostics regardless of which branches run.
  const isProjectList = decision.route === "project_list";
  let endreProjectCount = 0;
  let firestoreProjectCount = 0;
  let combinedProjectCount = 0;
  // Set when an account truncation warning was suppressed on a non-account route.
  let accountWarningsPruned = false;

  // Only include internal document ids in the model context when the user
  // explicitly asks for an id; otherwise they are kept out of the answer entirely
  // (ids still live in dataUsed/sources collection paths for internal use).
  const includeIds = WANTS_IDS.test(message);

  const firestoreCollections: string[] = [];
  const warnings: string[] = [];
  const context: ContextBlock = {};
  const notes: string[] = [];

  if (followUp.isFollowUp && followUp.priorQuestion) {
    notes.push(
      `Dette er et oppfølgingsspørsmål. Det viser til det forrige spørsmålet: ` +
        `«${followUp.priorQuestion}». Bruk det forrige spørsmålet og de ` +
        `opplastede dokumentene i konteksten for å svare — ikke be brukeren gjenta seg.`,
    );
  }

  // --- Accounts -------------------------------------------------------------
  if (intent.topics.includes("accounts")) {
    const accounts = await getAccounts();
    firestoreCollections.push(COLLECTIONS.accounts);

    if (intent.accountLookup) {
      // Posting question ("Hva fører jeg X på?"): send only the accounts most
      // relevant to the expanded search terms, never the whole chart. The model
      // is told to suggest the closest match (and never invent a number).
      const ranked = rankAccounts(
        accounts,
        intent.searchTerms,
        MAX_LOOKUP_ACCOUNTS,
      );
      const picked = ranked.length > 0 ? ranked.map((r) => r.account) : accounts;
      context.accounts = picked
        .slice(0, MAX_LOOKUP_ACCOUNTS)
        .map((d) => normalizeAccount(d, includeIds));
      if (ranked.length === 0 && accounts.length > MAX_LOOKUP_ACCOUNTS) {
        warnings.push(
          `Fant ingen konto som matcher «${intent.lookupSubject}» direkte; viser et utvalg kontoer.`,
        );
      }
    } else {
      context.accounts = accounts
        .slice(0, MAX_ITEMS_PER_SOURCE)
        .map((d) => normalizeAccount(d, includeIds));
      // The "Viser kun X av Y kontoer" truncation warning is only meaningful when
      // the user actually asked for the whole chart (account_list). On any other
      // route accounts are incidental, so suppress it (and record that we did).
      if (accounts.length > MAX_ITEMS_PER_SOURCE) {
        if (decision.route === "account_list") {
          warnings.push(
            `Viser kun ${MAX_ITEMS_PER_SOURCE} av ${accounts.length} kontoer.`,
          );
        } else {
          accountWarningsPruned = true;
        }
      }
    }
  }

  // --- Project list (combine Endre + Firestore/local) -----------------------
  // A broad "which projects exist?" question. Endre alone is insufficient — the
  // current Endre user sees only a subset (e.g. 3025), while 7100/7101 live in
  // Firestore — so we ALWAYS query both, combine, and dedupe (number first, then
  // normalized name). Both sources are recorded so the answer cites its origin.
  const endreSourcesForList: string[] = [];
  if (isProjectList) {
    const listedEndre: ListedProject[] = [];
    const endreClient = getEndreClient();
    if (endreClient) {
      const fromEndre = await listEndreProjects(endreClient);
      if (fromEndre && fromEndre.length > 0) {
        listedEndre.push(...fromEndre);
        endreSourcesForList.push("Endre API: projects");
      }
    }
    endreProjectCount = listedEndre.length;

    const fsProjects = await getProjects();
    firestoreCollections.push(COLLECTIONS.projects);
    const listedFirestore: ListedProject[] = fsProjects.map((d) => ({
      projectNumber:
        d.project_number !== undefined && d.project_number !== null
          ? String(d.project_number)
          : null,
      projectName:
        typeof d.project_name === "string" && d.project_name.trim()
          ? d.project_name.trim()
          : null,
      id: d.id,
    }));
    firestoreProjectCount = listedFirestore.length;

    const combined = dedupeProjects([...listedEndre, ...listedFirestore]);
    combinedProjectCount = combined.length;
    // Internal ids are hidden by default; only surfaced when the user explicitly
    // asked for an id (and only Firestore-sourced entries carry one).
    context.projects = combined.map((p) => ({
      ...(includeIds && p.id ? { id: p.id } : {}),
      ...(p.projectName ? { project_name: p.projectName } : {}),
      ...(p.projectNumber ? { project_number: p.projectNumber } : {}),
    }));
    notes.push(
      "Feltet «projects» er en samlet liste over prosjekter fra både Endre (live) " +
        "og lokale prosjektdata, slått sammen med duplikater fjernet. List " +
        "prosjektnavn og prosjektnummer slik de står — ikke legg til vurderinger.",
    );
  }

  // --- Optional Endre live data (project questions) -------------------------
  // For project-summary questions, prefer live Endre data when the integration
  // is enabled AND credentials are configured (getEndreClient enforces both;
  // it returns null otherwise, so no Endre call is ever made). Any failure or a
  // missing project returns null and we fall through to Firebase/documents.
  const endreSources: string[] = [];
  let endreHandledProjects = false;
  if (decision.route === "project_summary") {
    // `endreReady()` mirrors what getEndreClient() gates on; logged separately so
    // diagnostics distinguish "integration off/misconfigured" from "Endre tried
    // but produced nothing". getEndreClient() returns null in the former case.
    const ready = endreReady();
    const endreClient = getEndreClient();
    const diag: EndreDiagnostics = {
      projectQuery: null,
      attemptedEndre: false,
      projectListCount: 0,
      normalizedProjectListCount: 0,
      endreFound: false,
      fallbackReason: null,
    };
    if (endreClient) {
      const endre = await buildEndreProjectContext(
        message,
        endreClient,
        diag,
        endreHint,
      );
      if (endre) {
        Object.assign(context, endre.context);
        endreSources.push(...endre.sources);
        endreHandledProjects = true;
        notes.push(
          "Prosjektdataene i feltene «endre_project»/«endre_projects» kommer fra " +
            "Endre (live prosjektsystem) og er den foretrukne kilden for dette " +
            "spørsmålet. Svar ut fra disse. Ikke gjengi rå felter eller id-er.",
        );
      }
    } else {
      // Flag off or credentials missing — getEndreClient() returned null, so no
      // Endre call was made and we fall back to Firebase/documents.
      diag.fallbackReason = "endre_client_unavailable";
    }
    // Safe diagnostics: route, booleans, project-number token, capability labels,
    // coded fallback reason. No payloads, tokens, credentials, ids, or history.
    logEndreDiagnostics(requestId, {
      route: decision.route,
      endreReady: ready,
      attemptedEndre: diag.attemptedEndre,
      projectQuery: diag.projectQuery,
      projectListCount: diag.projectListCount,
      normalizedProjectListCount: diag.normalizedProjectListCount,
      endreFound: diag.endreFound,
      endreSources: [...endreSources],
      fallbackReason: diag.fallbackReason,
    });
    if (diag.fallbackReason) fallbackReasons.push(diag.fallbackReason);
  }

  // We need the projects list to answer project questions OR to resolve a
  // project for budget lines / quantities. When Endre already answered the
  // project question, skip the Firestore project fetch (Endre is preferred).
  let projects: FirestoreDoc[] = [];
  const needProjectsList =
    !endreHandledProjects &&
    !isProjectList &&
    // Respect the route: don't pull projects into a route that excludes them
    // (e.g. account_list reached via the keyword-free projects+accounts fallback).
    decision.allowedSources.includes("projects") &&
    (intent.topics.includes("projects") || intent.needsProject);
  if (needProjectsList) {
    projects = await getProjects();
    // The projects collection was actually queried (to list and/or to resolve a
    // project for budget lines / quantities), so always record it as used.
    firestoreCollections.push(COLLECTIONS.projects);
    if (intent.topics.includes("projects")) {
      context.projects = projects
        .slice(0, MAX_ITEMS_PER_SOURCE)
        .map((d) => normalizeProject(d, includeIds));
      if (projects.length > MAX_ITEMS_PER_SOURCE) {
        warnings.push(
          `Viser kun ${MAX_ITEMS_PER_SOURCE} av ${projects.length} prosjekter.`,
        );
      }
    }
  }

  // --- Project-specific data (budget lines / quantities) --------------------
  if (intent.needsProject) {
    const resolution = resolveProject(message, intent.explicitProjectId, projects);

    if (resolution.status !== "resolved") {
      warnings.push(resolution.message);
      notes.push(resolution.message);
      // Always expose the projects list so the model can help the user choose.
      // (projects is already recorded in firestoreCollections above.)
      if (!context.projects) {
        context.projects = projects
          .slice(0, MAX_ITEMS_PER_SOURCE)
          .map((d) => normalizeProject(d, includeIds));
      }
    } else {
      const { projectId } = resolution;
      // Include projectId in context only when the user asked for ids.
      const idBlock = includeIds ? { projectId } : {};

      if (intent.topics.includes("budgetLines")) {
        const rows = await getBudgetLines(projectId);
        const summary = summarizeRows(rows, { includeIds });
        context.budget_lines = { ...idBlock, ...summary };
        firestoreCollections.push(COLLECTIONS.budgetLines(projectId));
        if (summary.truncated) {
          warnings.push(
            `Budsjettlinjer: ${summary.count} rader aggregert; viser ${summary.sample.length} eksempler.`,
          );
        }
      }

      if (intent.topics.includes("quantities")) {
        const rows = await getQuantities(projectId);
        const summary = summarizeRows(rows, { includeIds });
        context.quantities = { ...idBlock, ...summary };
        firestoreCollections.push(COLLECTIONS.quantities(projectId));
        if (summary.truncated) {
          warnings.push(
            `Mengder: ${summary.count} rader aggregert; viser ${summary.sample.length} eksempler.`,
          );
        }
      }
    }
  }

  // --- Authoritative entity resolution + known metric value -----------------
  // Resolve the project against the data we now hold (Endre context, Firestore
  // list and history), then look for the requested metric's value. Prefer a
  // structured source (Endre/Firestore field); fall back to a value already
  // established in the conversation. This drives both the deterministic answer
  // path below and the answer verifier further down.
  const resolvedEntity = resolveEntity({ message, history, projects });
  let knownValue: number | string | null = null;
  let valueSource: MetricValueSource | null = null;
  // Only single-value project questions use the known-value / deterministic path.
  // Capacity, account and row-aggregate (budget/quantities) routes are untouched.
  const isMetricLookup =
    Boolean(plan.metric) &&
    plan.intent === "project_metric" &&
    decision.route === "project_summary";
  if (plan.metric && isMetricLookup) {
    const doc = resolvedEntity.projectId
      ? projects.find((p) => p.id === resolvedEntity.projectId)
      : undefined;
    if (doc) {
      const v = readMetricField(doc, plan.metric);
      if (v !== null) {
        knownValue = v;
        valueSource = "structured";
      }
    }
    if (knownValue === null && context.endre_project) {
      const v = readMetricField(
        context.endre_project as Record<string, unknown>,
        plan.metric,
      );
      if (v !== null) {
        knownValue = v;
        valueSource = "structured";
      }
    }
    if (knownValue === null && historyFacts.metrics[plan.metric] !== undefined) {
      knownValue = historyFacts.metrics[plan.metric]!;
      valueSource = "history";
    }
  }

  // --- Deterministic project-metric answer ----------------------------------
  // A direct, single-value project question ("Hva er kontraktsverdien på
  // Pilestredet?") with a resolved project + metric + value is answered here,
  // WITHOUT relying on the LLM to re-infer a value it may have shown a turn ago.
  // Row-aggregate routes (budget_lines/quantities) keep their normal path.
  const hasResolvedProject = Boolean(
    resolvedEntity.projectNumber || resolvedEntity.projectName,
  );
  if (
    plan.metric &&
    isMetricLookup &&
    hasResolvedProject &&
    knownValue !== null &&
    valueSource !== null
  ) {
    const answer = buildProjectMetricAnswer({
      metric: plan.metric,
      value: knownValue,
      projectName: resolvedEntity.projectName,
      projectNumber: resolvedEntity.projectNumber,
      question: message,
    });
    deterministicAnswerUsed = true;
    const sources = [...firestoreCollections, ...endreSources];
    if (valueSource === "history") sources.push("Samtalehistorikk");

    logChatPlan(requestId, {
      intent: plan.intent,
      resolvedProjectNumber: resolvedEntity.projectNumber,
      resolvedProjectName: resolvedEntity.projectName,
      resolvedMetric: plan.metric,
      confidence: plan.confidence,
      selectedSources: sources,
      checkedSources: [...firestoreCollections, ...endreSources],
      answerFound: true,
      deterministicAnswerUsed: true,
      fallbackReasons,
    });

    return {
      answer,
      sources,
      dataUsed: { firestoreCollections, documents: [] },
      warnings,
      route: decision.route,
      diagnostics: {
        intent: plan.intent,
        resolvedProjectNumber: resolvedEntity.projectNumber,
        resolvedProjectName: resolvedEntity.projectName,
        resolvedMetric: plan.metric,
        confidence: plan.confidence,
        selectedSources: sources,
        checkedSources: [...firestoreCollections, ...endreSources],
        answerFound: true,
        deterministicAnswerUsed: true,
        fallbackReasons,
        verifierAction: "none",
      },
    };
  }

  // --- Document / RAG search -----------------------------------------------
  // For account-posting questions, expand the query with related accounting
  // terms (synonyms + category words) and an anchor toward the chart of accounts,
  // so the closest matching account is found even when the exact word is absent.
  let matches: DocumentMatch[] = [];
  if (isProjectList) {
    // A combined project list answers from the structured projects field only —
    // no document chunks (they would just add noise and irrelevant sources).
    matches = [];
  } else if (intent.capacity) {
    // Staffing/capacity question: search the staffing plan aggressively. Boost
    // the bemanningsplan document, capacity-related sheets and role/month terms;
    // exclude the chart of accounts; pull more chunks than usual.
    const demand = intent.capacityDemand;
    const roleTerms = demand?.roles.map((r) => r.role.toLowerCase()) ?? [];
    const monthTerm = demand?.startMonth ? [demand.startMonth] : [];
    const searchQuery = [
      retrievalText,
      "bemanningsplan kapasitet tilgjengelig timer rotasjonsplan bemanning ressurser fordeling",
      ...roleTerms,
      ...monthTerm,
    ].join(" ");
    matches = await searchDocuments(searchQuery, {
      limit: MAX_CAPACITY_MATCHES,
      boostDocumentNames: ["bemanning"],
      boostSheetNames: [
        "rotasjonsplan",
        "bemanning",
        "kapasitet",
        "ressurs",
        "ressurser",
        "timer",
        "fordeling",
      ],
      boostTerms: [...new Set([...ALL_ROLE_TERMS, ...roleTerms, ...monthTerm])],
      excludeDocumentNames: ["kontoplan", "chart of accounts"],
    });
  } else {
    let searchQuery = retrievalText;
    if (intent.accountLookup) {
      searchQuery = [retrievalText, ...intent.searchTerms, "kontoplan", "konto"].join(
        " ",
      );
    }
    // Honour the route's document exclusions (e.g. account/project answers must
    // not pull in the staffing plan) and chunk budget.
    matches = await searchDocuments(searchQuery, {
      limit: decision.maxChunks,
      ...(decision.excludeDocumentNames.length > 0
        ? { excludeDocumentNames: decision.excludeDocumentNames }
        : {}),
    });
  }
  if (matches.length > 0) {
    // The model sees chunk text; the client only gets compact references.
    context.documents = matches.map((m) => ({
      documentName: m.documentName,
      ...(m.sheetName ? { sheetName: m.sheetName } : {}),
      chunkIndex: m.chunkIndex,
      text: m.text,
    }));
  }

  const documents: DocumentReference[] = matches.map((m) => ({
    documentId: m.documentId,
    documentName: m.documentName,
    fileType: m.fileType,
    ...(m.sheetName ? { sheetName: m.sheetName } : {}),
    chunkIndex: m.chunkIndex,
  }));
  const documentNames = [...new Set(matches.map((m) => m.documentName))];

  // For capacity questions, read availability deterministically from STRUCTURED
  // staffing-plan rows first (falling back to text scraping inside analyzeCapacity
  // when no structured rows exist), compute the demand breakdown, and hand the
  // model a structured note so it answers from the staffing plan, not guesswork.
  let structuredAvail: StructuredAvailability | null = null;
  if (intent.capacity) {
    structuredAvail = readStructuredAvailability(await getStructuredTables());
  }

  if (intent.capacity && intent.capacityDemand) {
    const analysis = analyzeCapacity(
      intent.capacityDemand,
      matches,
      structuredAvail?.byRole,
    );
    notes.push(formatCapacityNote(analysis));
    context.capacity_demand = {
      totalHours: analysis.totalDemandHours,
      startMonth: analysis.startMonth,
      roles: analysis.demand,
      ...(analysis.hasAvailability
        ? {
            available: analysis.available,
            gaps: analysis.gaps,
            availabilitySource: analysis.availabilitySource,
          }
        : {}),
    };
  }

  // Month-by-month availability (e.g. "tilgjengelig kapasitet hver måned"): only
  // possible from structured rows. Expose it as its own context + note so the
  // model lists per-month figures and always states the period and source.
  if (intent.capacity && structuredAvail && structuredAvail.byMonth.length > 0) {
    context.monthly_capacity = structuredAvail.byMonth.map((m) => ({
      month: m.month,
      byRole: m.byRole,
      total: m.total,
    }));
    const monthLines = structuredAvail.byMonth
      .map((m) => `- ${m.month}: ${formatHours(m.total)} timer tilgjengelig`)
      .join("\n");
    notes.push(
      "Tilgjengelig kapasitet per måned (strukturert fra bemanningsplanen):\n" +
        `${monthLines}\n` +
        `Kilde: ${structuredAvail.sources.join(", ") || "bemanningsplan"}. ` +
        "Oppgi alltid periode og kilde i svaret.",
    );
  }

  // Surface what the conversation already established (resolved project + any
  // known value) so the model uses it instead of refusing — but it should still
  // verify against the structured data in the context when present.
  if (resolvedEntity.projectName || resolvedEntity.projectNumber) {
    const ref =
      resolvedEntity.projectName && resolvedEntity.projectNumber
        ? `${resolvedEntity.projectName} (prosjekt ${resolvedEntity.projectNumber})`
        : resolvedEntity.projectName ?? `prosjekt ${resolvedEntity.projectNumber}`;
    notes.push(
      `Spørsmålet gjelder ${ref}. Bruk dette til å finne riktig data og svar — ` +
        `ikke be brukeren oppgi prosjektet på nytt.`,
    );
  }
  if (plan.metric && knownValue !== null) {
    notes.push(
      `Verdien for «${plan.metric}» er allerede kjent fra ` +
        `${valueSource === "history" ? "samtalen" : "strukturerte data"}: ` +
        `${knownValue}. Svar med denne verdien — ikke si at informasjonen mangler.`,
    );
  }

  // Append the route's answer-format guardrail so the answer is shaped correctly
  // (concrete account, capacity conclusion, project-only summary, …).
  notes.push(decision.answerFormat);

  // --- Logging (safe: ids/route/intent/collections only) -------------------
  // endreSources are capability labels only ("Endre API: …") — no payloads/ids.
  logChatResolved(requestId, [decision.route, ...intent.topics], [
    ...firestoreCollections,
    ...endreSources,
  ]);

  // --- Ask the model (via the pluggable provider) --------------------------
  const contextJson = JSON.stringify(context, null, 2);
  const note = notes.length > 0 ? notes.join("\n\n") : undefined;
  const userPrompt = buildUserPrompt(message, contextJson, note);

  const provider = getLLMProvider();
  const raw = await provider.generateAnswer({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    context,
  });

  let answer = raw.trim() || "Jeg har ikke nok informasjon til å svare på det.";

  // Verify the drafted answer: if we know the requested metric value but the
  // model omitted it or claimed missing information, substitute the correct,
  // deterministic answer. (Belt-and-braces on top of the deterministic path.)
  let verifierAction = "none";
  if (knownValue !== null && valueSource !== null) {
    const verdict = verifyAnswer({
      plan,
      question: message,
      answer,
      known: {
        value: knownValue,
        source: valueSource,
        projectName: resolvedEntity.projectName,
        projectNumber: resolvedEntity.projectNumber,
      },
    });
    if (!verdict.ok && verdict.replacement) {
      answer = verdict.replacement;
      deterministicAnswerUsed = true;
      verifierAction = "replaced_deterministic";
      if (verdict.reason) fallbackReasons.push(verdict.reason);
    } else {
      verifierAction = "passed";
    }
  }

  // Sources: Firestore collection paths, document names, and any Endre
  // capabilities used — each clearly marked so the answer cites its origin.
  // (endreSourcesForList carries the project_list combine; endreSources the
  // single-project summary path — only one is ever populated per request.)
  const allEndreSources = [...endreSources, ...endreSourcesForList];
  const checkedSources = [
    ...firestoreCollections,
    ...documentNames,
    ...allEndreSources,
  ];
  // Prune sources that did not contribute / the route excluded (e.g. an Endre
  // label that produced nothing, or an "accounts" collection pulled in only by
  // the broad projects+accounts fallback on a project route).
  const prune = pruneSources(checkedSources, {
    excludedSources: decision.excludedSources,
    endreContributed: allEndreSources.length > 0,
  });
  const sources = prune.sources;
  if (prune.prunedAccounts) accountWarningsPruned = true;

  const diagnostics: ChatDiagnostics = {
    intent: plan.intent,
    resolvedProjectNumber: resolvedEntity.projectNumber,
    resolvedProjectName: resolvedEntity.projectName,
    resolvedMetric: plan.metric ?? null,
    confidence: plan.confidence,
    selectedSources: sources,
    checkedSources,
    answerFound: knownValue !== null || sources.length > 0,
    deterministicAnswerUsed,
    fallbackReasons,
    verifierAction,
    ...(isProjectList
      ? { endreProjectCount, firestoreProjectCount, combinedProjectCount }
      : {}),
    ...(accountWarningsPruned ? { accountWarningsPruned: true } : {}),
  };
  logChatPlan(requestId, diagnostics);

  return {
    answer,
    sources,
    dataUsed: { firestoreCollections, documents },
    warnings,
    route: decision.route,
    diagnostics,
  };
}
