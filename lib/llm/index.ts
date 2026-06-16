/**
 * LLM provider factory.
 *
 * Selects the provider from LLM_PROVIDER (default "openai"). The orchestrator
 * calls getLLMProvider() and never imports a concrete provider directly.
 */

import "server-only";
import { env } from "@/lib/env";
import { createOpenAIProvider } from "@/lib/llm/openaiProvider";
import { createOllamaProvider } from "@/lib/llm/ollamaProvider";
import type { LLMProvider } from "@/lib/llm/types";

export type { LLMProvider, GenerateAnswerInput, LlmProvider } from "@/lib/llm/types";

let cached: LLMProvider | undefined;
let cachedFor: string | undefined;

export function getLLMProvider(): LLMProvider {
  const provider = env.llm.provider();
  // Memoise per provider value so a config change yields a fresh instance.
  if (cached && cachedFor === provider) return cached;

  switch (provider) {
    case "openai":
      cached = createOpenAIProvider();
      break;
    case "ollama":
      cached = createOllamaProvider();
      break;
    default:
      throw new Error(
        `Unsupported LLM_PROVIDER "${provider}". Supported: openai, ollama.`,
      );
  }
  cachedFor = provider;
  return cached;
}
