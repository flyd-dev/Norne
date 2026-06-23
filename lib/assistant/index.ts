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

import {
  runChat,
  type ChatResult,
  type RunChatOptions,
} from "@/lib/chat/orchestrator";
import { env } from "@/lib/env";
import type { HistoryMessage } from "@/lib/chat/historyFacts";

export type { ChatResult, RunChatOptions } from "@/lib/chat/orchestrator";
export type { HistoryMessage } from "@/lib/chat/historyFacts";

/**
 * Run one assistant turn: the public, stable surface. `history` is the current
 * chat only (the assistant never carries context across chats). Returns the
 * answer plus sources, data-used, warnings, route and diagnostics.
 *
 * When ASSISTANT_AGENT_MODE is on, the turn runs through the full agentic
 * tool-calling loop (the model chooses + chains tools and reasons over results);
 * otherwise it runs the deterministic pipeline. The agent module is imported
 * lazily so the deterministic path carries no agent/OpenAI overhead when off.
 */
export async function runAssistantTurn(
  message: string,
  requestId: string,
  history: HistoryMessage[] = [],
  options: RunChatOptions = {},
): Promise<ChatResult> {
  if (env.assistant.agentMode()) {
    // The agent loop has its own (non-streaming) path; options are ignored.
    const { runAgentTurn } = await import("@/lib/assistant/agent/run");
    return runAgentTurn(message, requestId, history);
  }
  return runChat(message, requestId, history, options);
}
