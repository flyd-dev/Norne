/**
 * Agent runtime: wires the agentic loop to the real data sources and the OpenAI
 * model, and shapes the result as a ChatResult so it is a drop-in for the
 * deterministic runChat. Used only when ASSISTANT_AGENT_MODE is on.
 *
 * The tools own the facts (validated, with the persons→hours estimate and
 * contract-value honesty); the model orchestrates and explains. Never throws —
 * the loop degrades to a safe answer on any tool/model failure.
 */

import "server-only";
import { runAgent, type AgentMessage } from "@/lib/assistant/agent/loop";
import { AGENT_TOOLS, type AgentDeps } from "@/lib/assistant/agent/agentTools";
import { createOpenAIAgentModel } from "@/lib/llm/openaiAgent";
import { getStructuredTables } from "@/lib/documents/store";
import { getProjects, getAccounts } from "@/lib/firestore/service";
import { searchDocuments, MAX_CAPACITY_MATCHES } from "@/lib/rag/documentSearch";
import { getEndreClient } from "@/lib/endre/client";
import { logChatPlan } from "@/lib/logger";
import type { AgentModel } from "@/lib/assistant/agent/loop";
import type { ChatDiagnostics, ChatResult } from "@/lib/chat/orchestrator";
import type { HistoryMessage } from "@/lib/chat/historyFacts";

const AGENT_SYSTEM = `Du er Norne Assistant, en intern AI-assistent for Nornebygg.
Du svarer ved å KALLE VERKTØY og resonnere over resultatene — du finner aldri på tall, kontoer, datoer eller felter selv.

Regler:
- Bruk verktøy for alle fakta. Tall, prosjektdata, kontoer og kapasitet skal komme fra verktøyresultater.
- Hvis et verktøy sier at et felt mangler (f.eks. kontraktsverdi i Endre), si det ærlig — ikke bruk et annet beløp som om det var feltet.
- Bland aldri kilder: Endre-beløp (TotalAmount o.l.) er ikke «kontraktsverdi» eller «forventet resultat».
- Kapasitet i timer fra get_available_hours_for_month er et ESTIMAT (personer × 208 t/mnd) — si at det er et estimat og hvilken måned/kilde det gjelder.
- Hvis spørsmålet er for vagt til å velge verktøy, still ett kort oppklaringsspørsmål i stedet for å gjette.
- Svar kort og praktisk på norsk. Oppgi kilde når du bruker tall.`;

/** Convert client history to agent messages (user/assistant turns only). */
function toAgentHistory(history: HistoryMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.content });
  }
  return out;
}

function buildDeps(): AgentDeps {
  return {
    getStructuredTables,
    getProjects,
    getAccounts,
    searchDocuments: (q: string) => searchDocuments(q, { limit: MAX_CAPACITY_MATCHES }),
    endreClient: getEndreClient(),
  };
}

/**
 * Run one turn through the agent. `modelOverride` lets tests inject a scripted
 * AgentModel instead of the live OpenAI one.
 */
export async function runAgentTurn(
  message: string,
  requestId: string,
  history: HistoryMessage[] = [],
  modelOverride?: AgentModel,
): Promise<ChatResult> {
  const model = modelOverride ?? createOpenAIAgentModel();
  const result = await runAgent({
    model,
    system: AGENT_SYSTEM,
    userMessage: message,
    history: toAgentHistory(history),
    tools: AGENT_TOOLS,
    deps: buildDeps(),
    maxSteps: 6,
  });

  const diagnostics: ChatDiagnostics = {
    intent: "agent",
    resolvedProjectNumber: null,
    resolvedProjectName: null,
    resolvedMetric: null,
    confidence: "n/a",
    selectedSources: result.sources,
    checkedSources: result.sources,
    answerFound: result.toolRuns.some((t) => t.ok),
    deterministicAnswerUsed: false,
    fallbackReasons: result.hitStepLimit ? ["agent_step_limit"] : [],
    verifierAction: "none",
    toolsRun: result.toolRuns.map((t) => ({
      tool: t.tool,
      coverage: t.ok ? "ok" : "failed",
    })),
  };
  logChatPlan(requestId, diagnostics);

  return {
    answer: result.answer,
    sources: result.sources,
    dataUsed: { firestoreCollections: [], documents: [] },
    warnings: [],
    route: "agent",
    diagnostics,
  };
}
