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
import { resolveProject } from "@/lib/chat/projectResolver";
import { searchDocuments, type DocumentMatch } from "@/lib/rag/documentSearch";
import { getLLMProvider } from "@/lib/llm";
import { SYSTEM_PROMPT, buildUserPrompt } from "@/lib/chat/prompts";
import { logChatResolved } from "@/lib/logger";

/** Max top-level docs (accounts/projects) included in the model context. */
const MAX_ITEMS_PER_SOURCE = 50;

export interface ChatDataUsed {
  /** Firestore collection paths the answer is based on. */
  firestoreCollections: string[];
  /** Document/RAG matches (empty until RAG is implemented). */
  documents: DocumentMatch[];
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

  const firestoreCollections: string[] = [];
  const warnings: string[] = [];
  const context: ContextBlock = {};
  let note: string | undefined;

  // --- Accounts -------------------------------------------------------------
  if (intent.topics.includes("accounts")) {
    const accounts = await getAccounts();
    context.accounts = accounts.slice(0, MAX_ITEMS_PER_SOURCE).map(normalizeAccount);
    firestoreCollections.push(COLLECTIONS.accounts);
    if (accounts.length > MAX_ITEMS_PER_SOURCE) {
      warnings.push(
        `Viser kun ${MAX_ITEMS_PER_SOURCE} av ${accounts.length} kontoer.`,
      );
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
        .map(normalizeProject);
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
          .map(normalizeProject);
      }
    } else {
      const { projectId } = resolution;

      if (intent.topics.includes("budgetLines")) {
        const rows = await getBudgetLines(projectId);
        const summary = summarizeRows(rows);
        context.budget_lines = { projectId, ...summary };
        firestoreCollections.push(COLLECTIONS.budgetLines(projectId));
        if (summary.truncated) {
          warnings.push(
            `Budsjettlinjer: ${summary.count} rader aggregert; viser ${summary.sample.length} eksempler.`,
          );
        }
      }

      if (intent.topics.includes("quantities")) {
        const rows = await getQuantities(projectId);
        const summary = summarizeRows(rows);
        context.quantities = { projectId, ...summary };
        firestoreCollections.push(COLLECTIONS.quantities(projectId));
        if (summary.truncated) {
          warnings.push(
            `Mengder: ${summary.count} rader aggregert; viser ${summary.sample.length} eksempler.`,
          );
        }
      }
    }
  }

  // --- Document / RAG search (placeholder; returns [] for now) --------------
  const documents: DocumentMatch[] = await searchDocuments(message);
  if (documents.length > 0) {
    context.documents = documents;
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

  const sources = [...firestoreCollections];
  if (documents.length > 0) sources.push("documents");

  return {
    answer,
    sources,
    dataUsed: { firestoreCollections, documents },
    warnings,
  };
}
