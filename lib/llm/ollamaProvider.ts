/**
 * Ollama (local Llama) LLM provider.
 *
 * Talks to a local or remote Ollama server over its HTTP API. OLLAMA_BASE_URL
 * may point at local Ollama (http://localhost:11434) or a remote/protected
 * endpoint (https://ollama.example.com). An OLLAMA_API_KEY is optional: when set
 * it is sent as `Authorization: Bearer <key>` (e.g. for a reverse proxy with
 * bearer auth). Server-side only for consistency with the other provider.
 *
 * Ollama chat API: POST {baseUrl}/api/chat
 *   { model, messages:[{role,content}], stream:false } -> { message:{ content } }
 */

import "server-only";
import { env } from "@/lib/env";
import type { GenerateAnswerInput, LLMProvider } from "@/lib/llm/types";

interface OllamaChatResponse {
  message?: { content?: string };
  /** "length" when generation stopped at num_predict (truncated). */
  done_reason?: string;
  error?: string;
}

export function createOllamaProvider(): LLMProvider {
  const baseUrl = env.ollama.baseUrl().replace(/\/+$/, "");
  const model = env.ollama.model();
  const apiKey = env.ollama.apiKey();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Only attach auth when a key is configured (local Ollama usually has none).
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return {
    name: "ollama",
    async generateAnswer({ systemPrompt, userPrompt, maxTokens, model: modelOverride, onTruncated }: GenerateAnswerInput) {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelOverride ?? model,
          stream: false,
          // num_predict is Ollama's output-token cap; omit to keep the default.
          options: { temperature: 0.2, ...(maxTokens ? { num_predict: maxTokens } : {}) },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        throw new Error(`Ollama request failed (HTTP ${res.status}).`);
      }

      const data = (await res.json()) as OllamaChatResponse;
      if (data.error) {
        // Surface a terse error; the model/server detail is logged by type only.
        throw new Error("Ollama returned an error response.");
      }
      if (data.done_reason === "length") onTruncated?.();
      return (data.message?.content ?? "").trim();
    },
  };
}
