/**
 * Agent runtime: wires the agentic loop to the real data sources and the active
 * provider's model (Claude by default, OpenAI fallback), and shapes the result
 * as a ChatResult so it is a drop-in for the deterministic runChat. Used only
 * when ASSISTANT_AGENT_MODE is on.
 *
 * The tools own the facts (validated, with the persons→hours estimate and
 * contract-value honesty); the model orchestrates and explains. Never throws —
 * the loop degrades to a safe answer on any tool/model failure.
 */

import "server-only";
import { runAgent, type AgentMessage } from "@/lib/assistant/agent/loop";
import { AGENT_TOOLS, type AgentDeps } from "@/lib/assistant/agent/agentTools";
import { createAnthropicAgentModel } from "@/lib/llm/anthropicAgent";
import { createOpenAIAgentModel } from "@/lib/llm/openaiAgent";
import { env } from "@/lib/env";
import { getStructuredTables, listDocuments } from "@/lib/documents/store";
import { getProjects, getAccounts, getBudgetLines, getQuantities } from "@/lib/firestore/service";
import { searchDocuments, MAX_CAPACITY_MATCHES } from "@/lib/rag/documentSearch";
import { getEndreClient } from "@/lib/endre/client";
import { readDossier } from "@/lib/dossier/store";
import { logChatPlan } from "@/lib/logger";
import type { AgentModel } from "@/lib/assistant/agent/loop";
import type { ChatDiagnostics, ChatResult, RunChatOptions } from "@/lib/chat/orchestrator";
import type { HistoryMessage } from "@/lib/chat/historyFacts";

const AGENT_SYSTEM = `Du er Norne Assistant, en intern assistent for Nornebygg. Du svarer naturlig og samtalebasert, og du resonnerer selv over dataene — som en vanlig, dyktig kollega som har fått tilgang til firmaets data.

Du har verktøy som leser Nornes egne data: prosjekter (lokale + Endre), kontoplan, bemanningsplanens ark (rådata med kolonner og rader), opplastede dokumenter, og saksdossieret for Nornebygg/HEYAS-saken. Bruk list_sources hvis du er usikker på hva som finnes. Les det du trenger og regn/vurder selv — det er ingen ferdige fasitsvar i verktøyene, bare dataene.

Forstå spørsmålet etter MENING, ikke etter nøkkelord. Et spørsmål om «en prosessvurdering / sannsynlighet for ulike utfall / hvordan saken står» er et spørsmål om rettssaken — kall get_case_dossier og svar ut fra saken, ikke som om det gjaldt et prosjektnummer. Finn ut hva brukeren faktisk vil vite før du velger verktøy.

Nornebygg/HEYAS-saken: dette er en pågående rettssak (HEYAS-konsortiet, inkl. Fjellbygg/Nornebygg, mot Lyngdal kommune i Agder tingrett om en opsjonsavtale). Du står på lag med dette teamet. Saksdossieret (get_case_dossier) er din grundige, ferdig analyserte oversikt — sakens kjerne, parter, tidslinje, omtvistede punkter, styrker OG svakheter, og status. På saksspørsmål: kjenn saken gjennom dossieret, svar raskt og presist, og bygg på dokumentene for konkrete sitater. Vær ærlig også om det som IKKE er i HEYAS' favør. Du kan beskrive og analysere styrker/svakheter og gi en kvalitativ vurdering (f.eks. lav/moderat/høy sannsynlighet med begrunnelse), men gi ALDRI bindende juridiske råd og konkludér ikke skråsikkert om endelig utfall — ved reell juridisk vurdering eller tvil, vis til advokaten. Ikke del saksinnhold eksternt.

Bruk verktøy KUN når brukeren ber om konkrete data eller en vurdering som krever dem. På hilsener, småprat, «hva kan du?» og spørsmål om deg selv: svar direkte uten verktøy, og ikke hent tilfeldige data du ikke ble bedt om.

Du er et LESE- og oppslagsverktøy: du kan ikke opprette, endre eller slette data (faktura, mengder, status i Tripletex/Endre osv.). Blir du bedt om en slik skrivehandling, forklar vennlig at du ikke kan utføre den, og tilby heller å finne tallene/dokumentene brukeren trenger.

Vær ærlig: oppgi bare tall og fakta du faktisk finner i dataene. Mangler noe, eller er du usikker (f.eks. hva en kolonne betyr, eller om en enhet er personer eller timer), så si det heller enn å gjette. Bland ikke sammen felter fra ulike kilder som om de betyr det samme. Er spørsmålet uklart, still ett kort oppklaringsspørsmål.

Svar på norsk, presist og så kort som spørsmålet tillater, og oppgi kilden (dokument/ark/prosjekt/dossier) når du bruker tall eller saksfakta. Gi sluttsvaret direkte til brukeren — ikke ta med din interne resonnering, mellomregninger eller verktøy-planlegging i selve svaret.`;

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
    readCaseDossier: async () => (await readDossier())?.text ?? null,
    endreClient: getEndreClient(),
  };
}

/**
 * Pick the agent model for the active provider. Claude (Anthropic) is the
 * default; OpenAI is the fallback. Ollama has no tool-calling agent model, so it
 * falls back to OpenAI here.
 */
function createAgentModel(): AgentModel {
  return env.llm.provider() === "anthropic"
    ? createAnthropicAgentModel()
    : createOpenAIAgentModel();
}

/**
 * Emit `text` to `onToken` in small chunks so the client renders the answer
 * progressively (the ChatGPT-style typing effect). The agent reasons + calls
 * tools first and only then writes the answer, so we stream the finished answer
 * rather than raw model deltas — the user still sees it type out word by word.
 */
function streamAnswer(text: string, onToken: (chunk: string) => void): void {
  // Split on whitespace boundaries, keeping the separators, so words arrive one
  // at a time without losing spacing/newlines.
  const parts = text.match(/\S+\s*/g);
  if (!parts) {
    onToken(text);
    return;
  }
  for (const part of parts) onToken(part);
}

/**
 * Run one turn through the agent. `modelOverride` lets tests inject a scripted
 * AgentModel instead of the live provider one. When `options.onToken` is set the
 * final answer is streamed to it.
 */
export async function runAgentTurn(
  message: string,
  requestId: string,
  history: HistoryMessage[] = [],
  modelOverride?: AgentModel,
  options: RunChatOptions = {},
): Promise<ChatResult> {
  const model = modelOverride ?? createAgentModel();
  const result = await runAgent({
    model,
    system: AGENT_SYSTEM,
    userMessage: message,
    history: toAgentHistory(history),
    tools: AGENT_TOOLS,
    deps: buildDeps(),
    maxSteps: 6,
  });

  if (options.onToken) streamAnswer(result.answer, options.onToken);

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
