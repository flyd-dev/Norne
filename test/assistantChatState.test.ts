/**
 * ChatState tests — explicit, conversation-scoped state (plan point 4):
 *   - new chat → empty state, hasContext false (drives clarification)
 *   - "Oppsummer prosjekt 7100" then "Hva er kontraktsverdien?" → currentProject 7100
 *   - capacity discussion → currentCapacityScope carries the inclusive bound
 *   - a clarification question as the last assistant turn → pendingClarification
 */

import { describe, expect, it } from "vitest";
import { deriveChatState } from "@/lib/assistant/state/chatState";
import { CLARIFICATION_QUESTION } from "@/lib/chat/clarify";
import type { HistoryMessage } from "@/lib/chat/historyFacts";

const u = (content: string): HistoryMessage => ({ role: "user", content });
const a = (content: string): HistoryMessage => ({ role: "assistant", content });

describe("deriveChatState", () => {
  it("new chat: empty, no context", () => {
    const s = deriveChatState([]);
    expect(s.hasContext).toBe(false);
    expect(s.currentProject).toBeNull();
    expect(s.currentCapacityScope).toBeNull();
    expect(s.lastToolResult).toBeNull();
  });

  it("keeps the project in focus across a metric follow-up", () => {
    const s = deriveChatState([
      u("Oppsummer prosjekt 7100"),
      a("Prosjekt 7100 (Pilestredet) …"),
      u("Hva er kontraktsverdien?"),
    ]);
    expect(s.currentProject?.projectNumber).toBe("7100");
    expect(s.lastTopic).toBe("project");
  });

  it("carries the inclusive capacity bound after a capacity discussion", () => {
    const s = deriveChatState([
      u("Vis tilgjengelig kapasitet frem til september 2026"),
      a("Juli/August/September …"),
    ]);
    expect(s.currentCapacityScope).not.toBeNull();
    expect(s.currentCapacityScope!.bound).toMatchObject({ kind: "upTo", month: 9, year: 2026 });
  });

  it("flags a pending clarification from the last assistant turn", () => {
    const s = deriveChatState([
      u("Gi meg det du har frem til september 2026"),
      a(CLARIFICATION_QUESTION),
    ]);
    expect(s.pendingClarification).toBe(true);
  });

  it("threads lastToolResult forward when supplied", () => {
    const s = deriveChatState([u("Vis kapasitet")], {
      lastToolResult: { tool: "getMonthlyCapacity", coverage: "full" },
    });
    expect(s.lastToolResult).toEqual({ tool: "getMonthlyCapacity", coverage: "full" });
  });
});
