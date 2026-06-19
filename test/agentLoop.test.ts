/**
 * Agent loop tests, driven by a scripted fake model so the multi-step behaviour
 * is pinned deterministically: tool calls execute, results feed back, a failing
 * or unknown tool yields an error payload (never throws), and the step budget is
 * enforced.
 */

import { describe, expect, it } from "vitest";
import { runAgent, type AgentModel, type AgentStep, type AgentTool } from "@/lib/assistant/agent/loop";

interface Deps { value: number }

const tool: AgentTool<Deps> = {
  name: "get_value",
  description: "returns the dep value",
  parameters: { type: "object", properties: {} },
  async execute(_args, deps) {
    return { value: deps.value };
  },
};
const throwingTool: AgentTool<Deps> = {
  name: "boom",
  description: "always throws",
  parameters: { type: "object", properties: {} },
  async execute() {
    throw new Error("boom");
  },
};

/** A model that plays a fixed list of steps in order. */
function scriptedModel(steps: AgentStep[]): AgentModel {
  let i = 0;
  return { step: async () => steps[Math.min(i++, steps.length - 1)] };
}

describe("runAgent", () => {
  it("calls a tool, feeds the result back, then answers", async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: "1", name: "get_value", args: {} }] },
      { content: "Verdien er 42." },
    ]);
    const r = await runAgent({ model, system: "s", userMessage: "?", tools: [tool], deps: { value: 42 } });
    expect(r.answer).toBe("Verdien er 42.");
    expect(r.toolRuns).toEqual([{ tool: "get_value", ok: true }]);
    expect(r.hitStepLimit).toBe(false);
  });

  it("handles an unknown tool without throwing", async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: "1", name: "nope", args: {} }] },
      { content: "Beklager." },
    ]);
    const r = await runAgent({ model, system: "s", userMessage: "?", tools: [tool], deps: { value: 1 } });
    expect(r.toolRuns).toEqual([{ tool: "nope", ok: false }]);
    expect(r.answer).toBe("Beklager.");
  });

  it("captures a throwing tool as a failed run, loop survives", async () => {
    const model = scriptedModel([
      { toolCalls: [{ id: "1", name: "boom", args: {} }] },
      { content: "Gikk galt, men jeg lever." },
    ]);
    const r = await runAgent({ model, system: "s", userMessage: "?", tools: [throwingTool], deps: { value: 1 } });
    expect(r.toolRuns).toEqual([{ tool: "boom", ok: false }]);
    expect(r.answer).toContain("lever");
  });

  it("enforces the step budget and forces a final answer", async () => {
    // Always asks for a tool → never answers on its own.
    const model: AgentModel = {
      step: async ({ tools }) =>
        tools.length > 0
          ? { toolCalls: [{ id: "x", name: "get_value", args: {} }] }
          : { content: "Tvunget sluttsvar." },
    };
    const r = await runAgent({ model, system: "s", userMessage: "?", tools: [tool], deps: { value: 1 }, maxSteps: 3 });
    expect(r.hitStepLimit).toBe(true);
    expect(r.answer).toBe("Tvunget sluttsvar.");
    expect(r.toolRuns.length).toBe(3);
  });

  it("survives a model that throws (returns a safe answer)", async () => {
    const model: AgentModel = { step: async () => { throw new Error("api down"); } };
    const r = await runAgent({ model, system: "s", userMessage: "?", tools: [tool], deps: { value: 1 } });
    expect(r.answer).toBeTruthy();
    expect(r.toolRuns).toEqual([]);
  });
});
