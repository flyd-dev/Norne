/**
 * OpenAI LLM provider. Server-side only (API key never reaches the browser).
 */

import "server-only";
import OpenAI from "openai";
import { env } from "@/lib/env";
import { isReasoningModel, samplingParams } from "@/lib/llm/openaiModel";
import type { GenerateAnswerInput, LLMProvider } from "@/lib/llm/types";

/** Output-cap param, named per model family (reasoning models renamed it). */
function tokenLimit(model: string, maxTokens?: number) {
  if (!maxTokens) return {};
  return isReasoningModel(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

export function createOpenAIProvider(): LLMProvider {
  const client = new OpenAI({ apiKey: env.openai.apiKey() });
  const model = env.openai.model();

  return {
    name: "openai",
    async generateAnswer({ systemPrompt, userPrompt, maxTokens, model: modelOverride, onTruncated }: GenerateAnswerInput) {
      const effModel = modelOverride ?? model;
      const completion = await client.chat.completions.create({
        model: effModel,
        ...samplingParams(effModel),
        ...tokenLimit(effModel, maxTokens),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      const choice = completion.choices[0];
      // finish_reason "length" = the model hit the output cap (truncated).
      if (choice?.finish_reason === "length") onTruncated?.();
      return choice?.message?.content?.trim() ?? "";
    },

    async *streamAnswer({ systemPrompt, userPrompt }: GenerateAnswerInput) {
      const stream = await client.chat.completions.create({
        model,
        ...samplingParams(model),
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}
