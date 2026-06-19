/**
 * OpenAI implementation of the agent model (function calling). Server-side only.
 *
 * Translates the provider-agnostic AgentMessage/AgentToolSchema shapes to the
 * OpenAI chat-completions tool-calling format and parses tool calls back. This is
 * the only OpenAI-specific piece of the agent; the loop (lib/assistant/agent)
 * stays provider-neutral and is driven by the `step` method defined here.
 */

import "server-only";
import OpenAI from "openai";
import { env } from "@/lib/env";
import { samplingParams } from "@/lib/llm/openaiModel";
import type {
  AgentMessage,
  AgentModel,
  AgentStep,
  AgentToolSchema,
} from "@/lib/assistant/agent/loop";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** AgentMessage[] → OpenAI chat messages (with a leading system message). */
function toOpenAIMessages(
  system: string,
  messages: AgentMessage[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: m.content ?? "",
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        });
      } else {
        out.push({ role: "assistant", content: m.content ?? "" });
      }
    } else {
      // tool result
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

function toOpenAITools(tools: AgentToolSchema[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Build an AgentModel backed by OpenAI chat-completions function calling. */
export function createOpenAIAgentModel(): AgentModel {
  const client = new OpenAI({ apiKey: env.openai.apiKey() });
  const model = env.openai.model();

  return {
    async step({ system, messages, tools }): Promise<AgentStep> {
      const completion = await client.chat.completions.create({
        model,
        ...samplingParams(model),
        messages: toOpenAIMessages(system, messages),
        ...(tools.length > 0
          ? { tools: toOpenAITools(tools), tool_choice: "auto" as const }
          : {}),
      });
      const msg = completion.choices[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];
      if (toolCalls.length > 0) {
        return {
          toolCalls: toolCalls
            .filter((c) => c.type === "function")
            .map((c) => ({
              id: c.id,
              name: c.function.name,
              args: parseArgs(c.function.arguments),
            })),
        };
      }
      return { content: msg?.content?.trim() ?? "" };
    },
  };
}
