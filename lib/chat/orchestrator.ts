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
import { searchDocuments } from "@/lib/rag/documentSearch";
import type { DocumentReference } from "@/lib/documents/types";
import { getLLMProvider } from "@/lib/llm";
import { SYSTEM_PROMPT, buildUserPrompt } from "@/lib/chat/prompts";
import { logChatResolved } from "@/lib/logger";

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
}

type ContextBlock = Record<string, unknown>;

export async function runChat(
  message: string,
  requestId: string,
): Promise<ChatResult> {
  const intent = detectIntent(message);

  // Only include internal document ids in the model context when the user
  // explicitly asks for an id; otherwise they are kept out of the answer entirely
  // (ids still live in dataUsed/sources collection paths for internal use).
  const includeIds = WANTS_IDS.test(message);

  const firestoreCollections: string[] = [];
  const warnings: string[] = [];
  const context: ContextBlock = {};
  let note: string | undefined;

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
      note = resolution.message;
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
  let searchQuery = message;
  if (intent.accountLookup) {
    searchQuery = [message, ...intent.searchTerms, "kontoplan", "konto"].join(
      " ",
    );
  }
  const matches = await searchDocuments(searchQuery);
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

  // For account-posting questions, steer the model toward a concrete account
  // answer (closest match if the exact term is missing) rather than a summary.
  if (intent.accountLookup && !note) {
    note =
      `Brukeren spør hva «${intent.lookupSubject}» skal føres på. ` +
      `Finn den/de best passende kontoen(e) i kontoplanen eller konto-dataene over. ` +
      `Bruk KUN kontonumre som faktisk står i konteksten — aldri finn på et kontonummer. ` +
      `Finnes ikke «${intent.lookupSubject}» eksakt, si det tydelig og foreslå nærmeste relevante konto. ` +
      `Ikke ta med prosjektoppsummeringer.`;
  }

  // --- Logging (safe: ids/intent/collections only) -------------------------
  logChatResolved(requestId, intent.topics, firestoreCollections);

  // --- Ask the model (via the pluggable provider) --------------------------
  const contextJson = JSON.stringify(context, null, 2);
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
  };
}
