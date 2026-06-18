/**
 * Tool runner — the dispatch spine (plan flow A–J).
 *
 * Given a selected tool plan, the tool inputs and a request-scoped ToolContext,
 * it validates and runs each tool, never throwing: a tool that fails validation
 * or errors yields a `none` result so the caller degrades gracefully rather than
 * crashing the turn. The orchestrator builds the ToolContext (resolves projects,
 * fetches accounts/chunks) and consumes these results to build the model context
 * and sources — so the cutover from inline branches to tools is incremental.
 *
 * Tools own the facts (validated, with explicit coverage); the model only ever
 * reasons over what comes back here.
 */

import {
  none,
  type ToolContext,
  type ToolRegistry,
  type ToolResult,
} from "@/lib/assistant/tools/registry";
import type { ToolName } from "@/lib/assistant/tools/index";
import type { ToolPlan } from "@/lib/assistant/planner";

export interface ToolRun {
  tool: ToolName;
  result: ToolResult<unknown>;
}

/** Validate + run one tool by name. Never throws. */
export async function dispatchTool(
  name: ToolName,
  rawInput: unknown,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolRun> {
  const tool = registry.get(name);
  if (!tool) {
    return { tool: name, result: none(`Ukjent verktøy: ${name}`) };
  }
  const validated = tool.validate(rawInput);
  if (!validated.ok) {
    return { tool: name, result: none(`Ugyldig input for ${name}: ${validated.error}`) };
  }
  try {
    const result = await tool.run(validated.input, ctx);
    return { tool: name, result };
  } catch {
    // Tools should not throw, but the runner must survive it if one does.
    return { tool: name, result: none(`Verktøyet ${name} feilet.`) };
  }
}

/**
 * Run every tool in the plan, in order. `inputs` maps a tool name to its raw
 * input (validated per tool). Returns one ToolRun per tool.
 */
export async function runToolPlan(
  plan: ToolPlan,
  inputs: Partial<Record<ToolName, unknown>>,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolRun[]> {
  const runs: ToolRun[] = [];
  for (const name of plan.tools) {
    runs.push(await dispatchTool(name, inputs[name] ?? {}, registry, ctx));
  }
  return runs;
}

/** All distinct source labels across the runs, in first-seen order. */
export function collectSources(runs: ToolRun[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const run of runs) {
    for (const s of run.result.sources) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

/**
 * The coverage to report for the turn: the BEST coverage any tool achieved
 * (full > partial > none). When the best is "none", the caller should show what
 * it has or ask — never conclude (plan point 3).
 */
export function turnCoverage(runs: ToolRun[]): "full" | "partial" | "none" {
  let best: "full" | "partial" | "none" = "none";
  for (const run of runs) {
    if (run.result.coverage === "full") return "full";
    if (run.result.coverage === "partial") best = "partial";
  }
  return best;
}
