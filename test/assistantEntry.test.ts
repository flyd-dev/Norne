/**
 * The runner is the public entry: runAssistantTurn delegates to the orchestrator
 * assembly and returns the same ChatResult contract. (Behaviour parity; the
 * deeper logic migration happens behind this seam without changing callers.)
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/chat/orchestrator", () => ({
  runChat: vi.fn(async (message: string, requestId: string) => ({
    answer: `svar:${message}`,
    sources: [],
    dataUsed: { firestoreCollections: [], documents: [] },
    warnings: [],
    route: "general" as const,
    diagnostics: { requestId } as unknown as Record<string, unknown>,
  })),
}));

import { runAssistantTurn } from "@/lib/assistant";
import { runChat } from "@/lib/chat/orchestrator";

describe("runAssistantTurn", () => {
  it("delegates to the orchestrator and returns its result", async () => {
    const r = await runAssistantTurn("hei", "req", []);
    expect(r.answer).toBe("svar:hei");
    expect(runChat).toHaveBeenCalledWith("hei", "req", [], {});
  });

  it("defaults history to empty", async () => {
    await runAssistantTurn("test", "req2");
    expect(runChat).toHaveBeenCalledWith("test", "req2", [], {});
  });
});
