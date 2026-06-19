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
import { getStructuredTables, listDocuments } from "@/lib/documents/store";
import { getProjects, getAccounts, getBudgetLines, getQuantities } from "@/lib/firestore/service";
import { searchDocuments, MAX_CAPACITY_MATCHES } from "@/lib/rag/documentSearch";
import { getEndreClient } from "@/lib/endre/client";
import { logChatPlan } from "@/lib/logger";
import type { AgentModel } from "@/lib/assistant/agent/loop";
import type { ChatDiagnostics, ChatResult } from "@/lib/chat/orchestrator";
import type { HistoryMessage } from "@/lib/chat/historyFacts";

const AGENT_SYSTEM = `Du er Norne Assistant, en intern assistent for Nornebygg. Du svarer naturlig og samtalebasert, og du resonnerer selv over dataene.

Du har verktøy som leser Nornes egne data: prosjekter, kontoplan, bemanningsplanens ark (rådata med kolonner og rader), og opplastede dokumenter. Bruk list_sources hvis du er usikker på hva som finnes. Les det du trenger og regn/vurder selv — det er ingen ferdige fasitsvar i verktøyene, bare dataene.

Bruk verktøy KUN når brukeren ber om konkrete data. På hilsener, småprat, «hva kan du?», «hvorfor» og spørsmål om deg selv: svar direkte uten verktøy, og ikke hent tilfeldige data du ikke ble bedt om.

Vær ærlig: oppgi bare tall og fakta du faktisk finner i dataene. Mangler noe, eller er du usikker (f.eks. hva en kolonne betyr, eller om en enhet er personer eller timer), så si det heller enn å gjette. Bland ikke sammen felter fra ulike kilder som om de betyr det samme. Er spørsmålet uklart, still ett kort oppklaringsspørsmål.

Svar på norsk, kort og presist, og oppgi kilden (dokument/ark/prosjekt) når du bruker tall.`;

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
    getBudgetLines,
    getQuantities,
    listDocuments: async () =>
      (await listDocuments()).map((d) => ({ name: d.name, fileType: d.fileType })),
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
