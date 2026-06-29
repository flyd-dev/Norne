/**
 * Anthropic (Claude) LLM provider. Server-side only (API key never reaches the
 * browser). Mirrors the OpenAI provider: one grounded system+user turn in, the
 * trimmed text answer out.
 */

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import type { GenerateAnswerInput, LLMProvider } from "@/lib/llm/types";

/** Bounded output: grounded answers are short; keeps latency + cost in check. */
const MAX_TOKENS = 4096;

/** Join the text blocks of a Claude response into a single trimmed string. */
function textOf(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

export function createAnthropicProvider(): LLMProvider {
  // Generous explicit timeout: this provider also drives the case-dossier
  // synthesis — one long single call inside a long-running route (up to 800s).
  // Bound it under that ceiling so a hung call surfaces as a catchable error
  // rather than a silent function-level timeout. Interactive answers finish in
  // seconds, so this never affects normal latency.
  const client = new Anthropic({ apiKey: env.anthropic.apiKey(), timeout: 540_000 });
  const model = env.anthropic.model();

  return {
    name: "anthropic",
    async generateAnswer({ systemPrompt, userPrompt }: GenerateAnswerInput) {
      const message = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      return textOf(message.content);
    },
  };
}
