/**
 * Tool layer — the uniform boundary between the assistant and Norne's data.
 *
 * Every tool takes validated input and returns a `ToolResult`: structured data,
 * the sources it came from, and an explicit COVERAGE grade. Coverage is what
 * lets the rest of the system refuse to hallucinate — a tool that found nothing
 * returns `coverage: "none"` instead of an empty-but-plausible answer, and the
 * runner then asks the user or shows what it does have rather than concluding.
 *
 * Deterministic and dependency-free: tools wrap the existing reasoning modules
 * (capacity, projects, accounts, documents) behind one typed contract, so the
 * orchestrator/runner and — later — an LLM tool-choice loop can call them the
 * same way. Validation is a small pure function per tool (no schema dependency).
 */

/** How completely a tool answered the question it was given. */
export type Coverage = "full" | "partial" | "none";

export interface ToolResult<O> {
  /** The structured payload, or null when nothing was found. */
  data: O | null;
  /** Clearly-labelled sources the data came from (never raw payloads). */
  sources: string[];
  /** full = answered; partial = some data but not what was asked; none = nothing. */
  coverage: Coverage;
  /** Short machine/human reason, esp. for partial/none (e.g. "no contract-value field"). */
  note?: string;
}

/** Convenience constructors so tools stay terse and consistent. */
export const ok = <O>(data: O, sources: string[], note?: string): ToolResult<O> => ({
  data,
  sources,
  coverage: "full",
  ...(note ? { note } : {}),
});
export const partial = <O>(
  data: O | null,
  sources: string[],
  note: string,
): ToolResult<O> => ({ data, sources, coverage: "partial", note });
export const none = <O>(note: string, sources: string[] = []): ToolResult<O> => ({
  data: null,
  sources,
  coverage: "none",
  note,
});

/** Validate raw input into `I`, or explain why it is unusable. */
export type Validate<I> = (raw: unknown) => { ok: true; input: I } | { ok: false; error: string };

export interface Tool<I, O> {
  /** Stable identifier the planner and LLM refer to, e.g. "getMonthlyCapacity". */
  name: string;
  /** One line the planner/LLM uses to decide when this tool applies. */
  description: string;
  /** Pure input validation — keeps a tool from running on garbage. */
  validate: Validate<I>;
  /** Execute against shared context; never throws (return `none` on failure). */
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

/**
 * Shared, request-scoped data the tools read from. Populated once per turn by the
 * runner/orchestrator so individual tools stay free of I/O wiring and easy to
 * unit-test. Everything here is optional: a tool degrades to `none` when its
 * input source is absent.
 */
export interface ToolContext {
  /** Loader for structured staffing tables (deferred so unused tools cost nothing). */
  getStructuredTables?: () => Promise<import("@/lib/documents/types").StoredStructuredTable[]>;
  /** Already-retrieved document chunks for the current question. */
  documentMatches?: import("@/lib/rag/documentSearch").DocumentMatch[];
  /**
   * The project the runner resolved for this turn (sanitized scalar fields +
   * any `amounts`/`contracts` aggregates), or null when none was resolved. The
   * project tools read facts off this record — resolution/fetch stays in the
   * runner so the tools remain pure and testable.
   */
  projectRecord?: Record<string, unknown> | null;
  /** Number/name of the resolved (or referenced) project. */
  projectRef?: { projectNumber: string | null; projectName: string | null };
  /** Source labels for the resolved project (e.g. ["Endre API: projects"]). */
  projectSources?: string[];
  /** The combined project list, for the project-list tool. */
  projectList?: import("@/lib/chat/endreSource").ListedProject[];
  /** Chart-of-accounts rows, for the account tools. */
  accounts?: import("@/lib/firestore/types").FirestoreDoc[];
}

/** A minimal, type-erased registry so tools can be looked up by name. */
export class ToolRegistry {
  private tools = new Map<string, Tool<unknown, unknown>>();

  register<I, O>(tool: Tool<I, O>): this {
    this.tools.set(tool.name, tool as unknown as Tool<unknown, unknown>);
    return this;
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<unknown, unknown>[] {
    return [...this.tools.values()];
  }
}
