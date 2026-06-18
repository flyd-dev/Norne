/**
 * Unit tests for the clarification layer: context-dependence detection,
 * conversation-state derivation, and the combined clarify decision.
 *
 * Pure functions only — no retrieval, no LLM. These pin the rule that a vague,
 * context-dependent question with no relevant current-chat context must clarify,
 * while a self-sufficient question (named project, concrete demand, list) or a
 * vague follow-up WITH relevant context must not.
 */

import { describe, expect, it } from "vitest";
import {
  analyzeContextDependence,
  decideClarification,
  CLARIFICATION_QUESTION,
} from "@/lib/chat/clarify";
import {
  deriveConversationState,
  hasRelevantContext,
} from "@/lib/chat/conversationState";
import type { HistoryMessage } from "@/lib/chat/historyFacts";

describe("analyzeContextDependence — vague messages", () => {
  const vague: [string, string][] = [
    ["Gi meg det du har frem til september 2026", "period"],
    ["Vis det", "generic"],
    ["Hva er status?", "generic"],
    ["Hva er kontraktsverdien?", "metric"],
    ["Hva har vi?", "generic"],
    ["Gi meg tallene", "generic"],
    ["Hva med september?", "period"],
  ];
  for (const [msg, kind] of vague) {
    it(`flags "${msg}" as ${kind}`, () => {
      const d = analyzeContextDependence(msg);
      expect(d.dependent).toBe(true);
      expect(d.kind).toBe(kind);
    });
  }
});

describe("analyzeContextDependence — self-sufficient messages", () => {
  const concrete = [
    "Oppsummer prosjekt 7100",
    "Hva er kontraktsverdien på Pilestredet?",
    "Hva er kontraktsverdien på AFBO NORA?",
    "Hvilke prosjekter finnes?",
    "Hvilke kontoer finnes?",
    "Hva fører jeg arbeidshansker på?",
    "Har vi kapasitet til 29 000 timer i august?",
  ];
  for (const msg of concrete) {
    it(`does not flag "${msg}"`, () => {
      expect(analyzeContextDependence(msg).dependent).toBe(false);
    });
  }
});

describe("deriveConversationState", () => {
  it("is empty for a new chat (no history)", () => {
    const s = deriveConversationState([]);
    expect(s.hasContext).toBe(false);
    expect(s.lastTopic).toBeNull();
    expect(s.lastProjectNumber).toBeNull();
    expect(s.lastCapacity).toBe(false);
    expect(s.turnCount).toBe(0);
  });

  it("captures a project topic + number from a summary turn", () => {
    const h: HistoryMessage[] = [
      { role: "user", content: "Oppsummer prosjekt 7100" },
      {
        role: "assistant",
        content: "Prosjektnavn: Pilestredet\nProsjektnummer: 7100",
      },
    ];
    const s = deriveConversationState(h);
    expect(s.hasContext).toBe(true);
    expect(s.lastTopic).toBe("project");
    expect(s.lastProjectNumber).toBe("7100");
  });

  it("captures a capacity topic from a staffing turn", () => {
    const h: HistoryMessage[] = [
      {
        role: "user",
        content:
          "Vi starter nytt prosjekt i august. ca 29.000 timer. Har vi kapasitet?",
      },
      { role: "assistant", content: "Behov per fag …" },
    ];
    const s = deriveConversationState(h);
    expect(s.lastCapacity).toBe(true);
    expect(s.lastTopic).toBe("capacity");
    // A capacity turn must not invent a project from the demand.
    expect(s.lastProjectNumber).toBeNull();
  });
});

describe("hasRelevantContext", () => {
  const projectState = deriveConversationState([
    { role: "user", content: "Oppsummer prosjekt 7100" },
    { role: "assistant", content: "Prosjektnummer: 7100" },
  ]);
  const capacityState = deriveConversationState([
    { role: "user", content: "Har vi kapasitet i august? 29 000 timer" },
    { role: "assistant", content: "Behov …" },
  ]);

  it("a metric follow-up needs a project in focus", () => {
    expect(hasRelevantContext(projectState, "metric")).toBe(true);
    expect(hasRelevantContext(capacityState, "metric")).toBe(false);
  });

  it("a period follow-up is satisfied by a prior capacity request", () => {
    expect(hasRelevantContext(capacityState, "period")).toBe(true);
  });
});

describe("decideClarification", () => {
  it("clarifies a vague opener in a new chat", () => {
    const s = deriveConversationState([]);
    const d = decideClarification("Gi meg det du har frem til september 2026", s);
    expect(d.required).toBe(true);
    expect(d.question).toBe(CLARIFICATION_QUESTION);
    expect(d.kind).toBe("period");
  });

  it("does not clarify a bare metric once a project is in focus", () => {
    const s = deriveConversationState([
      { role: "user", content: "Oppsummer prosjekt 7100" },
      { role: "assistant", content: "Prosjektnummer: 7100" },
    ]);
    expect(decideClarification("Hva er kontraktsverdien?", s).required).toBe(false);
  });

  it("clarifies a bare metric when only capacity was discussed", () => {
    const s = deriveConversationState([
      { role: "user", content: "Har vi kapasitet i august? 29 000 timer" },
      { role: "assistant", content: "Behov …" },
    ]);
    expect(decideClarification("Hva er kontraktsverdien?", s).required).toBe(true);
  });

  it("does not clarify a self-sufficient question", () => {
    const s = deriveConversationState([]);
    expect(decideClarification("Hvilke prosjekter finnes?", s).required).toBe(false);
  });
});
