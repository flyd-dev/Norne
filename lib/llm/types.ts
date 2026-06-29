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
  /**
   * Optional per-call output cap (tokens). When unset the provider uses its own
   * bounded default (short grounded answers). The case-dossier synthesis sets a
   * much higher value so a thorough multi-section overview isn't truncated.
   */
  maxTokens?: number;
  /**
   * Optional per-call model override. When unset the provider uses its configured
   * default. The dossier uses this to run the one-off synthesis on a top-tier
   * model (e.g. Opus) without changing the interactive chat model.
   */
  model?: string;
  /**
   * Called when the model stopped because it hit the output cap (the answer is
   * truncated). Lets the caller record/log that the result is incomplete instead
   * of it passing silently.
   */
  onTruncated?: () => void;
}

export interface LLMProvider {
  /** Identifies the concrete provider (useful for tests and logging). */
  readonly name: LlmProvider;
  /** Generate a grounded answer from the given prompts. */
  generateAnswer(input: GenerateAnswerInput): Promise<string>;
  /**
   * Optional streaming variant: yields the answer in text chunks as the model
   * produces them. When a provider doesn't implement it, callers fall back to
   * generateAnswer (one chunk). Used for the conversational + document/case
   * answers so the UI can render them as they're written.
   */
  streamAnswer?(input: GenerateAnswerInput): AsyncIterable<string>;
}
