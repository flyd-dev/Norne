/**
 * Explicit chat state (plan point 4).
 *
 * The assistant's memory is the current chat ONLY — a new chat starts empty and
 * nothing carries across chats. Today the state is RE-DERIVED from the history
 * the client sends each turn; this module reshapes that into the explicit,
 * structured form the product calls for, so the runner reads `state.currentProject`
 * instead of poking at loose flags:
 *
 *   { lastTopic, currentProject, currentDocument, currentCapacityScope,
 *     pendingClarification, knownProjectFacts, lastToolResult, ... }
 *
 * `lastToolResult` cannot be derived from history text — it is threaded forward
 * by the runner after a tool runs (and is null on a fresh derive). Everything
 * else is pure and dependency-free.
 */

import {
  deriveConversationState,
  type TopicKind,
} from "@/lib/chat/conversationState";
import { isClarificationQuestion } from "@/lib/chat/clarify";
import { parseMonthRange, type MonthBound } from "@/lib/chat/dateRange";
import { normalizeRole, type CanonicalRole } from "@/lib/chat/roles";
import type { HistoryMessage, ProjectMetricFacts } from "@/lib/chat/historyFacts";
import type { ProjectRef } from "@/lib/assistant/domain/project";
import type { Coverage } from "@/lib/assistant/tools/registry";

export interface CapacityScopeState {
  bound: MonthBound | null;
  role: CanonicalRole | null;
}

export interface LastToolResult {
  tool: string;
  coverage: Coverage;
}

export interface ChatState {
  /** True when this chat carries any relevant prior context at all. */
  hasContext: boolean;
  lastTopic: TopicKind;
  /** Project currently in focus (used so "Hva er kontraktsverdien?" knows which). */
  currentProject: ProjectRef | null;
  /** Document currently in focus, if a document question named one. */
  currentDocument: string | null;
  /** Capacity period/role most recently established (for "frem til …" follow-ups). */
  currentCapacityScope: CapacityScopeState | null;
  /** Set when the assistant's last turn asked a clarification awaiting an answer. */
  pendingClarification: boolean;
  /** Metric values established per project — never shared across projects. */
  knownProjectFacts: ProjectMetricFacts[];
  /** The last tool the runner ran this chat, threaded forward (null on derive). */
  lastToolResult: LastToolResult | null;
  turnCount: number;
}

/** The most recent capacity-bearing user turn, scanned newest-first. */
function deriveCapacityScope(history: HistoryMessage[]): CapacityScopeState | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user") continue;
    const bound = parseMonthRange(msg.content);
    const role = normalizeRole(msg.content);
    if (bound || role) return { bound: bound ?? null, role: role ?? null };
  }
  return null;
}

/** The last assistant turn, to detect a pending clarification. */
function lastAssistant(history: HistoryMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content;
  }
  return null;
}

export interface DeriveOptions {
  /** Carried forward by the runner from the previous turn's tool run. */
  lastToolResult?: LastToolResult | null;
}

/**
 * Derive the explicit ChatState from the current chat's history. Empty history
 * (a new chat) yields all-empty state and `hasContext: false` — which is exactly
 * what makes a vague opening question clarify instead of guessing a source.
 */
export function deriveChatState(
  history: HistoryMessage[] = [],
  opts: DeriveOptions = {},
): ChatState {
  const base = deriveConversationState(history);
  const currentProject: ProjectRef | null =
    base.lastProjectNumber || base.lastProjectName
      ? { projectNumber: base.lastProjectNumber, projectName: base.lastProjectName }
      : null;
  const last = lastAssistant(history);

  return {
    hasContext: base.hasContext,
    lastTopic: base.lastTopic,
    currentProject,
    currentDocument: null, // populated once a document tool runs (via runner)
    currentCapacityScope: base.lastCapacity ? deriveCapacityScope(history) : null,
    pendingClarification: last ? isClarificationQuestion(last) : false,
    knownProjectFacts: base.knownProjectFacts,
    lastToolResult: opts.lastToolResult ?? null,
    turnCount: base.turnCount,
  };
}
