/**
 * OpenAI LLM provider. Server-side only (API key never reaches the browser).
 */

import "server-only";
import OpenAI from "openai";
import { env } from "@/lib/env";
import { samplingParams } from "@/lib/llm/openaiModel";
import type { GenerateAnswerInput, LLMProvider } from "@/lib/llm/types";

export function createOpenAIProvider(): LLMProvider {
  const client = new OpenAI({ apiKey: env.openai.apiKey() });
  const model = env.openai.model();

  return {
    name: "openai",
    async generateAnswer({ systemPrompt, userPrompt }: GenerateAnswerInput) {
      const completion = await client.chat.completions.create({
        model,
        ...samplingParams(model),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      return completion.choices[0]?.message?.content?.trim() ?? "";
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
