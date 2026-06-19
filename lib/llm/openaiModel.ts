/**
 * Shared OpenAI model tuning.
 *
 * Reasoning models (the GPT-5 family and the o-series) reject a custom
 * `temperature` — only the default is allowed — so we must omit it for them. For
 * the older chat models we keep a low temperature for stable, grounded answers.
 * Centralised so both the plain provider and the agent provider agree.
 */

/** True for OpenAI reasoning models (gpt-5*, o1/o3/o4…), which forbid temperature. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model.trim());
}

/** Optional sampling params for a model: temperature only when it's allowed. */
export function samplingParams(model: string): { temperature?: number } {
  return isReasoningModel(model) ? {} : { temperature: 0.2 };
}
