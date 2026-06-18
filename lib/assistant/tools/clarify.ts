/**
 * Clarification tool — askClarifyingQuestion.
 *
 * Clarification is a deliberate action, not a failure (plan point 5). When the
 * question is too vague to pick a data source, the runner calls this tool to
 * return a short, structured clarification instead of fetching random data.
 */

import { ok, type Tool } from "@/lib/assistant/tools/registry";

export interface ClarifyInput {
  /** Why we need to clarify (kept short; surfaced for diagnostics). */
  reason: string;
  /** Concrete options to offer the user, e.g. ["prosjektdata","bemanning"]. */
  options?: string[];
}

export interface ClarifyOutput {
  reason: string;
  options: string[];
}

export const askClarifyingQuestion: Tool<ClarifyInput, ClarifyOutput> = {
  name: "askClarifyingQuestion",
  description:
    "Still et kort, presist oppklaringsspørsmål når spørsmålet er for vagt til å " +
    "velge datakilde. Hent aldri tilfeldige data i stedet.",
  validate: (raw) => {
    const input = raw as Partial<ClarifyInput> | null;
    if (!input || typeof input.reason !== "string") {
      return { ok: false, error: "reason is required" };
    }
    return {
      ok: true,
      input: {
        reason: input.reason,
        ...(Array.isArray(input.options) ? { options: input.options } : {}),
      },
    };
  },
  async run(input) {
    return ok({ reason: input.reason, options: input.options ?? [] }, []);
  },
};
