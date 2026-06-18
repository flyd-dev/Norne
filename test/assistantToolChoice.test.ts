/**
 * T3.7: LLM tool-choice. The model picks within the deterministic tool's family
 * (never crossing the source policy), and any decline/error falls back to the
 * deterministic plan.
 */

import { describe, expect, it } from "vitest";
import { chooseToolViaLLM, resolveToolPlan } from "@/lib/assistant/toolChoice";
import type { ToolPlan } from "@/lib/assistant/planner";
import type { LLMProvider } from "@/lib/llm/types";

const provider = (reply: string): LLMProvider => ({
  name: "openai",
  generateAnswer: async () => reply,
});
const throwing: LLMProvider = {
  name: "openai",
  generateAnswer: async () => {
    throw new Error("boom");
  },
};

const plan = (over: Partial<ToolPlan>): ToolPlan => ({
  tools: ["getMonthlyCapacity"],
  clarify: false,
  llmFallbackAdvised: true,
  ...over,
});
const desc = {
  getMonthlyCapacity: "per måned",
  getAvailableCapacity: "totalt per fag",
};

describe("chooseToolViaLLM", () => {
  it("parses an exact tool name", async () => {
    const r = await chooseToolViaLLM({
      message: "har vi nok folk totalt?",
      candidates: [
        { name: "getMonthlyCapacity", description: "" },
        { name: "getAvailableCapacity", description: "" },
      ],
      provider: provider("getAvailableCapacity"),
    });
    expect(r).toBe("getAvailableCapacity");
  });

  it("returns null on NONE / unrecognised", async () => {
    const r = await chooseToolViaLLM({
      message: "x",
      candidates: [{ name: "getMonthlyCapacity", description: "" }],
      provider: provider("NONE"),
    });
    expect(r).toBeNull();
  });
});

describe("resolveToolPlan", () => {
  it("lets the model switch within the family on low confidence", async () => {
    const r = await resolveToolPlan(plan({}), "totalt?", desc, provider("getAvailableCapacity"));
    expect(r.tools).toEqual(["getAvailableCapacity"]);
  });

  it("never crosses families (model reply outside family is ignored)", async () => {
    const r = await resolveToolPlan(plan({}), "x", desc, provider("getProjectMetric"));
    // getProjectMetric is not in the capacity family → not offered → fallback.
    expect(r.tools).toEqual(["getMonthlyCapacity"]);
  });

  it("keeps deterministic choice when not advised", async () => {
    const r = await resolveToolPlan(
      plan({ llmFallbackAdvised: false }),
      "x",
      desc,
      provider("getAvailableCapacity"),
    );
    expect(r.tools).toEqual(["getMonthlyCapacity"]);
  });

  it("falls back on provider error", async () => {
    const r = await resolveToolPlan(plan({}), "x", desc, throwing);
    expect(r.tools).toEqual(["getMonthlyCapacity"]);
  });

  it("no-op without a provider", async () => {
    const r = await resolveToolPlan(plan({}), "x", desc, null);
    expect(r.tools).toEqual(["getMonthlyCapacity"]);
  });
});
