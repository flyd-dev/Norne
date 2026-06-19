import { describe, expect, it } from "vitest";
import { isReasoningModel, samplingParams } from "@/lib/llm/openaiModel";

describe("openai model tuning", () => {
  it("treats gpt-5 family and o-series as reasoning models", () => {
    for (const m of ["gpt-5.5", "gpt-5", "gpt-5-mini", "o1", "o3-mini", "o4"]) {
      expect(isReasoningModel(m)).toBe(true);
    }
  });

  it("treats older chat models as non-reasoning", () => {
    for (const m of ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-3.5-turbo"]) {
      expect(isReasoningModel(m)).toBe(false);
    }
  });

  it("omits temperature for reasoning models, keeps it otherwise", () => {
    expect(samplingParams("gpt-5.5")).toEqual({});
    expect(samplingParams("gpt-4o-mini")).toEqual({ temperature: 0.2 });
  });
});
