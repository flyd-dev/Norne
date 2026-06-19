/**
 * Provider-agnostic agentic tool-calling loop (the "full reasoning" core).
 *
 * The model is given the tool SCHEMAS and decides which tools to call, in what
 * order, reasoning over each result before the next step — a real multi-step
 * agent, not a one-shot completion. The tools still own the facts (validated,
 * deterministic), so the model orchestrates but never invents numbers.
 *
 * The model is injected as `AgentModel.step`, so the loop is fully testable with
 * a scripted fake — the OpenAI implementation lives in lib/llm and is the only
 * provider-specific piece. The loop never throws: a failing tool returns an error
 * payload the model can react to, and the step budget bounds cost/latency.
 */

export interface AgentToolCall {
  /** Provider-assigned id, echoed back with the tool result. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One model turn: either it asks for tool calls, or it gives the final answer. */
export interface AgentStep {
  toolCalls?: AgentToolCall[];
  content?: string;
}

/** Conversation entry, shaped to translate cleanly to OpenAI chat messages. */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface AgentToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface AgentModel {
  /** One round-trip: given the conversation + tool schemas, return the next step. */
  step(input: {
    system: string;
    messages: AgentMessage[];
    tools: AgentToolSchema[];
  }): Promise<AgentStep>;
}

/** A tool the agent can call: schema + a self-contained executor (does its own I/O). */
export interface AgentTool<Deps> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Execute the call. Should not throw; return a JSON-serializable result. */
  execute(args: Record<string, unknown>, deps: Deps): Promise<unknown>;
}

export interface AgentRunInput<Deps> {
  model: AgentModel;
  system: string;
  userMessage: string;
  history?: AgentMessage[];
  tools: AgentTool<Deps>[];
  deps: Deps;
  /** Max model round-trips before forcing a final answer. */
  maxSteps?: number;
}

export interface AgentRunResult {
  answer: string;
  /** Tools the agent actually invoked this turn, with success flags. */
  toolRuns: { tool: string; ok: boolean }[];
  /** True when the step budget was hit before a final answer. */
  hitStepLimit: boolean;
}

const DEFAULT_MAX_STEPS = 6;
const NO_ANSWER = "Jeg klarte ikke å fullføre svaret.";

/** Run the agent loop. Never throws. */
export async function runAgent<Deps>(
  input: AgentRunInput<Deps>,
): Promise<AgentRunResult> {
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const schemas: AgentToolSchema[] = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const messages: AgentMessage[] = [
    ...(input.history ?? []),
    { role: "user", content: input.userMessage },
  ];
  const toolRuns: { tool: string; ok: boolean }[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const step = await safeStep(input.model, {
      system: input.system,
      messages,
      tools: schemas,
    });

    if (step.toolCalls && step.toolCalls.length > 0) {
      messages.push({ role: "assistant", toolCalls: step.toolCalls });
      for (const call of step.toolCalls) {
        const tool = byName.get(call.name);
        let result: unknown;
        let ok = true;
        if (!tool) {
          result = { error: `Ukjent verktøy: ${call.name}` };
          ok = false;
        } else {
          try {
            result = await tool.execute(call.args ?? {}, input.deps);
          } catch {
            result = { error: `Verktøyet ${call.name} feilet.` };
            ok = false;
          }
        }
        toolRuns.push({ tool: call.name, ok });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: safeJson(result),
        });
      }
      continue;
    }

    // No tool calls → the model produced (or declined) a final answer.
    return { answer: step.content?.trim() || NO_ANSWER, toolRuns, hitStepLimit: false };
  }

  // Step budget exhausted: ask once more WITHOUT tools to force a final answer.
  const final = await safeStep(input.model, {
    system: input.system,
    messages,
    tools: [],
  });
  return {
    answer: final.content?.trim() || NO_ANSWER,
    toolRuns,
    hitStepLimit: true,
  };
}

async function safeStep(
  model: AgentModel,
  input: { system: string; messages: AgentMessage[]; tools: AgentToolSchema[] },
): Promise<AgentStep> {
  try {
    return await model.step(input);
  } catch {
    return { content: NO_ANSWER };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"error":"kunne ikke serialisere resultatet"}';
  }
}
