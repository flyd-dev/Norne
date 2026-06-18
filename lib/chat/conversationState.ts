/**
 * Conversation-scoped state.
 *
 * The assistant's memory is the current chat ONLY. A new chat sends no history,
 * so this state starts empty — there is no carry-over of project/entity context
 * between chats. Inside one chat the client appends each turn to `history`, and
 * this module re-derives a structured snapshot of what the conversation has
 * established so far:
 *
 *   - lastTopic / lastRoute        what the last substantive turn was about
 *   - lastProjectNumber/Name       the project most recently in focus
 *   - lastCapacity                 a staffing/capacity request happened earlier
 *   - lastAccountTopic             an account/kontoplan question happened earlier
 *   - lastDocumentTopic            a document question happened earlier
 *   - knownProjectFacts            metric values grouped per project (no leakage)
 *   - turnCount                    number of user turns seen
 *
 * It is pure and dependency-free; history is used transiently and never logged.
 * The orchestrator uses it to decide whether a vague follow-up actually has
 * relevant context to lean on, or whether it must ask the user to clarify.
 */

import {
  extractHistoryFacts,
  type HistoryMessage,
  type ProjectMetricFacts,
} from "@/lib/chat/historyFacts";
import { detectAccountLookup } from "@/lib/chat/accountLookup";
import { detectCapacityIntent } from "@/lib/chat/capacity";
import {
  extractProjectNameFromText,
  extractProjectNumberFromText,
} from "@/lib/chat/entityResolver";

/** The coarse subject a turn was about. */
export type TopicKind = "project" | "capacity" | "account" | "document" | null;

export interface ConversationState {
  /** True when the current chat carries any relevant prior context at all. */
  hasContext: boolean;
  /** The subject of the most recent substantive user turn. */
  lastTopic: TopicKind;
  /** Project most recently in focus (from history facts). */
  lastProjectNumber: string | null;
  lastProjectName: string | null;
  /** A staffing/capacity request happened earlier in this chat. */
  lastCapacity: boolean;
  /** An account/kontoplan question happened earlier in this chat. */
  lastAccountTopic: boolean;
  /** A document question happened earlier in this chat. */
  lastDocumentTopic: boolean;
  /** Metric values established per project, never shared across projects. */
  knownProjectFacts: ProjectMetricFacts[];
  /** Number of user turns observed. */
  turnCount: number;
}

/** A user turn is substantive if it carries enough to retrieve against. */
function isSubstantive(content: string): boolean {
  if (content.trim().split(/\s+/).length >= 4) return true;
  return /\d/.test(content);
}

/** Classify a single user turn into a coarse topic. */
function classifyTurn(content: string): TopicKind {
  if (detectAccountLookup(content).isLookup) return "account";
  if (detectCapacityIntent(content)) return "capacity";
  if (
    extractProjectNumberFromText(content) ||
    extractProjectNameFromText(content) ||
    /\bprosjekt(er|et|ene)?\b/i.test(content)
  ) {
    return "project";
  }
  if (/\bkonto(er|ene|plan)?\b/i.test(content)) return "account";
  return null;
}

/**
 * Derive the structured state from the current chat's history. With empty
 * history (a new chat) every flag is false / null and `hasContext` is false —
 * this is what makes a vague opening question trigger a clarification instead of
 * defaulting to project data.
 */
export function deriveConversationState(
  history: HistoryMessage[] = [],
): ConversationState {
  const facts = extractHistoryFacts(history);

  let lastTopic: TopicKind = null;
  let lastCapacity = false;
  let lastAccountTopic = false;
  let lastDocumentTopic = false;
  let turnCount = 0;

  for (const msg of history) {
    if (msg.role !== "user") continue;
    if (!isSubstantive(msg.content)) continue;
    turnCount += 1;
    const topic = classifyTurn(msg.content);
    if (topic === "capacity") lastCapacity = true;
    if (topic === "account") lastAccountTopic = true;
    if (topic === "document") lastDocumentTopic = true;
    // The most recent substantive turn wins for lastTopic.
    if (topic) lastTopic = topic;
  }

  const hasContext =
    turnCount > 0 &&
    (lastTopic !== null ||
      lastCapacity ||
      lastAccountTopic ||
      lastDocumentTopic ||
      Boolean(facts.projectNumber || facts.projectName));

  return {
    hasContext,
    lastTopic,
    lastProjectNumber: facts.projectNumber,
    lastProjectName: facts.projectName,
    lastCapacity,
    lastAccountTopic,
    lastDocumentTopic,
    knownProjectFacts: facts.byProject,
    turnCount,
  };
}

/**
 * Whether the chat carries the specific context a vague follow-up of a given
 * kind needs:
 *   - "metric"  a project must be in focus (lastProject*).
 *   - "period"  a capacity request or a project must be in focus.
 *   - "generic" any prior topic at all.
 *
 * Topic-aware on purpose: a bare metric follow-up must NOT lean on a chat whose
 * only prior topic was capacity (that is project context the conversation never
 * established), so it clarifies instead.
 */
export function hasRelevantContext(
  state: ConversationState,
  kind: "metric" | "period" | "generic",
): boolean {
  const hasProject = Boolean(state.lastProjectNumber || state.lastProjectName);
  switch (kind) {
    case "metric":
      return hasProject && state.lastTopic === "project";
    case "period":
      return state.lastCapacity || hasProject;
    case "generic":
      return state.hasContext;
  }
}
