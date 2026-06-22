/**
 * Pluggable LLM provider abstraction.
 *
 * The orchestrator depends only on this interface, so the underlying model
 * (OpenAI, local Ollama/Llama, …) can be swapped via configuration without any
 * orchestrator changes.
 */

export const SUPPORTED_LLM_PROVIDERS = ["anthropic", "openai", "ollama"] as const;
export type LlmProvider = (typeof SUPPORTED_LLM_PROVIDERS)[number];

export interface GenerateAnswerInput {
  /** Grounding/system instructions (e.g. answer in Norwegian, don't invent). */
  systemPrompt: string;
  /** The user question plus the serialized retrieved context. */
  userPrompt: string;
  /** The raw retrieved context object (available to providers if useful). */
  context: unknown;
}

export interface LLMProvider {
  /** Identifies the concrete provider (useful for tests and logging). */
  readonly name: LlmProvider;
  /** Generate a grounded answer from the given prompts. */
  generateAnswer(input: GenerateAnswerInput): Promise<string>;
}
