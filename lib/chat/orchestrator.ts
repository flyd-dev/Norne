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
import { logChatResolved } from "@/lib/logger";
import {
  resolveFollowUp,
  type ChatHistoryMessage,
} from "@/lib/chat/followup";
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

export interface ChatResult {
  answer: string;
  /** All sources the answer draws on (collection paths + "documents"). */
  sources: string[];
  dataUsed: ChatDataUsed;
  /** Non-fatal notices (truncation, ambiguous/missing project, config mode). */
  warnings: string[];
  /** The route the question was classified into (for feedback + debugging). */
  route?: Route;
}

type ContextBlock = Record<string, unknown>;

export async function runChat(
  message: string,
  requestId: string,
  history: ChatHistoryMessage[] = [],
): Promise<ChatResult> {
  // Resolve short follow-ups ("sjekk den", "bruk bemanningsplanen") against the
  // most recent substantive question. Only the retrieval text is enriched; the
  // user still sees, and we still answer, the original message.
  const followUp = resolveFollowUp(message, history);
  const retrievalText = followUp.retrievalText;

  const intent = detectIntent(retrievalText);

  // Turn the intent into an explicit route with a fixed source/search/format
  // policy. The orchestrator obeys this instead of re-deriving rules inline.
  const decision = routeMessage(retrievalText, intent, followUp.isFollowUp);

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
      if (accounts.length > MAX_ITEMS_PER_SOURCE) {
        warnings.push(
          `Viser kun ${MAX_ITEMS_PER_SOURCE} av ${accounts.length} kontoer.`,
        );
      }
    }
  }

  // We need the projects list to answer project questions OR to resolve a
  // project for budget lines / quantities.
  let projects: FirestoreDoc[] = [];
  const needProjectsList = intent.topics.includes("projects") || intent.needsProject;
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

  // --- Document / RAG search -----------------------------------------------
  // For account-posting questions, expand the query with related accounting
  // terms (synonyms + category words) and an anchor toward the chart of accounts,
  // so the closest matching account is found even when the exact word is absent.
  let matches: DocumentMatch[];
  if (intent.capacity) {
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

  // Append the route's answer-format guardrail so the answer is shaped correctly
  // (concrete account, capacity conclusion, project-only summary, …).
  notes.push(decision.answerFormat);

  // --- Logging (safe: ids/route/intent/collections only) -------------------
  logChatResolved(requestId, [decision.route, ...intent.topics], firestoreCollections);

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

  const answer = raw.trim() || "Jeg har ikke nok informasjon til å svare på det.";

  // Sources: Firestore collection paths plus the document names used.
  const sources = [...firestoreCollections, ...documentNames];

  return {
    answer,
    sources,
    dataUsed: { firestoreCollections, documents },
    warnings,
    route: decision.route,
  };
}
