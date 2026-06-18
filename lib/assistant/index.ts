/**
 * Public entry point for the Norne Assistant.
 *
 * Callers (the /api/chat route, and any future surface) talk to the assistant
 * through `runAssistantTurn` — the runner — rather than importing the
 * orchestrator directly. This is the seam the architecture migrates along: the
 * runner already owns the turn's tool DECISION (state → planner → tool-choice,
 * see runner.ts/planTurnTools) and exposes it via diagnostics; the orchestrator
 * remains the answer-ASSEMBLY internals (retrieval, context, prompt, verify) and
 * is consumed here. Moving more of that assembly behind this entry doesn't change
 * the public contract — callers keep using runAssistantTurn.
 */

import { runChat, type ChatResult } from "@/lib/chat/orchestrator";
import type { HistoryMessage } from "@/lib/chat/historyFacts";

export type { ChatResult } from "@/lib/chat/orchestrator";
export type { HistoryMessage } from "@/lib/chat/historyFacts";

/**
 * Run one assistant turn: the public, stable surface. `history` is the current
 * chat only (the assistant never carries context across chats). Returns the
 * answer plus sources, data-used, warnings, route and diagnostics.
 */
export async function runAssistantTurn(
  message: string,
  requestId: string,
  history: HistoryMessage[] = [],
): Promise<ChatResult> {
  return runChat(message, requestId, history);
}
