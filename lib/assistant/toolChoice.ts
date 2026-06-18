/**
 * LLM tool-choice (plan point 8, Tier 3.7).
 *
 * The deterministic planner is the default and picks the tool for ~90% of
 * questions. For the long tail — phrasings the heuristics rank as low-confidence
 * — this lets the MODEL choose among the SAME tools. Crucially, the candidate
 * set is bounded upstream by the source policy: the model only ever sees the
 * tools the route already allows, so it cannot pick a project tool for a capacity
 * question. The model chooses the tool; the tool still owns the facts.
 *
 * Provider-agnostic: it uses the existing generateAnswer with a constrained
 * prompt and parses a single tool name back, so no function-calling plumbing is
 * required. Returns null when the model declines or answers unrecognisably —
 * the caller then falls back to the deterministic choice.
 */

import type { LLMProvider } from "@/lib/llm/types";
import type { ToolName } from "@/lib/assistant/tools/index";
import type { ToolPlan } from "@/lib/assistant/planner";

export interface ToolCandidate {
  name: ToolName;
  description: string;
}

export interface ChooseToolInput {
  message: string;
  candidates: ToolCandidate[];
  provider: LLMProvider;
}

const SYSTEM =
  "Du er en ruter. Velg PRESIS ett verktøy som best besvarer brukerens spørsmål, " +
  "eller svar NONE hvis ingen passer. Svar med KUN verktøynavnet, ingenting annet.";

function buildPrompt(message: string, candidates: ToolCandidate[]): string {
  const list = candidates.map((c) => `- ${c.name}: ${c.description}`).join("\n");
  return (
    `Brukerens spørsmål:\n${message}\n\n` +
    `Tilgjengelige verktøy:\n${list}\n\n` +
    `Svar med nøyaktig ett av disse navnene: ${candidates
      .map((c) => c.name)
      .join(", ")}, eller NONE.`
  );
}

/** Parse the model reply to one of the candidate names, or null. */
function parseChoice(reply: string, candidates: ToolCandidate[]): ToolName | null {
  const text = reply.trim();
  // Exact-name match first, then a contained match (the model may pad the name).
  for (const c of candidates) {
    if (text === c.name) return c.name;
  }
  for (const c of candidates) {
    if (text.includes(c.name)) return c.name;
  }
  return null;
}

/**
 * Ask the model to choose one tool from the bounded candidate set. Never throws:
 * any provider error or unrecognised reply yields null (→ deterministic fallback).
 */
export async function chooseToolViaLLM(
  input: ChooseToolInput,
): Promise<ToolName | null> {
  if (input.candidates.length === 0) return null;
  try {
    const reply = await input.provider.generateAnswer({
      systemPrompt: SYSTEM,
      userPrompt: buildPrompt(input.message, input.candidates),
      context: {},
    });
    return parseChoice(reply, input.candidates);
  } catch {
    return null;
  }
}

/**
 * Tool FAMILIES — sibling tools within ONE source policy. LLM tool-choice only
 * ever picks within a family, so the model can disambiguate (monthly vs total
 * capacity; metric vs summary vs list) but can NEVER cross into another data
 * source. This is the hard boundary that keeps the deterministic source policy
 * in force even when the model chooses.
 */
const FAMILIES: ToolName[][] = [
  ["getMonthlyCapacity", "getAvailableCapacity"],
  ["getProjectMetric", "getProjectSummary", "getProjectList"],
  ["searchChartOfAccounts", "getAccountForPurchase"],
  ["searchUploadedDocuments"],
];

function familyOf(tool: ToolName): ToolName[] {
  return FAMILIES.find((f) => f.includes(tool)) ?? [tool];
}

/**
 * Resolve the final tool plan. When the deterministic planner flagged low
 * confidence (llmFallbackAdvised) and a provider is available, let the model pick
 * among the deterministic tool's FAMILY; otherwise keep the deterministic choice.
 * Falls back to the deterministic plan on any decline/error.
 */
export async function resolveToolPlan(
  toolPlan: ToolPlan,
  message: string,
  descriptions: Partial<Record<ToolName, string>>,
  provider: LLMProvider | null,
): Promise<ToolPlan> {
  if (!toolPlan.llmFallbackAdvised || toolPlan.tools.length === 0 || !provider) {
    return toolPlan;
  }
  const family = familyOf(toolPlan.tools[0]);
  const candidates: ToolCandidate[] = family.map((name) => ({
    name,
    description: descriptions[name] ?? name,
  }));
  const chosen = await chooseToolViaLLM({ message, candidates, provider });
  return chosen ? { ...toolPlan, tools: [chosen] } : toolPlan;
}
