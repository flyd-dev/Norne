/**
 * Anthropic (Claude) implementation of the agent model (tool use). Server-side
 * only.
 *
 * Translates the provider-agnostic AgentMessage/AgentToolSchema shapes to the
 * Claude Messages tool-use format and parses tool calls back. This is the only
 * Anthropic-specific piece of the agent; the loop (lib/assistant/agent) stays
 * provider-neutral and is driven by the `step` method defined here.
 *
 * Two shape differences vs OpenAI worth noting:
 *  - Tool results are `tool_result` blocks inside a USER message (not a separate
 *    "tool" role). Consecutive results are coalesced into one user message, so
 *    parallel tool calls answer in a single turn (Claude keeps making them).
 *  - The model returns `tool_use` content blocks rather than a `tool_calls`
 *    array; we filter `content` by block type.
 */

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import type {
  AgentMessage,
  AgentModel,
  AgentStep,
  AgentToolSchema,
} from "@/lib/assistant/agent/loop";

/**
 * Bounded per-step output. Tool-arg steps are tiny, but the final answer can be
 * a full case/process assessment, so this is generous enough not to truncate it
 * (well under the streaming threshold, so a non-streamed call won't time out).
 */
const MAX_TOKENS = 8192;

/** AgentMessage[] → Claude messages, coalescing consecutive tool results. */
function toAnthropicMessages(
  messages: AgentMessage[],
): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      }
      // An assistant turn always carries text and/or tool calls in this loop.
      out.push({ role: "assistant", content: blocks });
    } else {
      // Tool result. Append to the preceding user message if it already holds
      // tool_result blocks, so parallel results land in one turn.
      const block: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

function toAnthropicTools(tools: AgentToolSchema[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
  }));
}

/** Build an AgentModel backed by the Claude Messages API tool-use loop. */
export function createAnthropicAgentModel(): AgentModel {
  const client = new Anthropic({ apiKey: env.anthropic.apiKey() });
  const model = env.anthropic.agentModel();

  return {
    async step({ system, messages, tools }): Promise<AgentStep> {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: toAnthropicMessages(messages),
        ...(tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
      });

      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length > 0) {
        return {
          toolCalls: toolUses.map((b) => ({
            id: b.id,
            name: b.name,
            args: (b.input ?? {}) as Record<string, unknown>,
          })),
        };
      }

      const text = response.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      return { content: text };
    },
  };
}
