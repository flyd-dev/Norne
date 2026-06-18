import { describe, expect, it } from "vitest";
import { detectIntent } from "@/lib/chat/intent";
import { routeMessage } from "@/lib/chat/router";
import { resolveFollowUp } from "@/lib/chat/followup";
import { planQuestion } from "@/lib/chat/questionPlanner";

function plan(message: string, history: { role: "user" | "assistant"; content: string }[] = []) {
  const followUp = resolveFollowUp(message, history);
  const intent = detectIntent(followUp.retrievalText);
  const decision = routeMessage(followUp.retrievalText, intent, followUp.isFollowUp);
  return planQuestion({
    message,
    retrievalText: followUp.retrievalText,
    intent,
    decision,
    history,
    isFollowUp: followUp.isFollowUp,
  });
}

describe("planQuestion", () => {
  it("classifies a named-project contract-value question as project_metric", () => {
    const p = plan("Hva er total kontraktsverdi på Pilestredet prosjektet?");
    expect(p.intent).toBe("project_metric");
    expect(p.metric).toBe("contract_value");
    expect(p.entities.projectName).toBe("Pilestredet");
  });

  it("uses history for an elliptical metric follow-up", () => {
    const p = plan("Hva er kontraktsverdien?", [
      { role: "user", content: "Oppsummer prosjekt 7100" },
      {
        role: "assistant",
        content: "Prosjektnummer: 7100\nKontraktsverdi: 150 705 668 kr",
      },
    ]);
    expect(p.intent).toBe("project_metric");
    expect(p.metric).toBe("contract_value");
    expect(p.entities.projectNumber).toBe("7100");
    expect(p.needsHistory).toBe(true);
  });

  it("keeps an open project question as project_summary", () => {
    const p = plan("Oppsummer prosjekt 7100");
    expect(p.intent).toBe("project_summary");
    expect(p.metric).toBeUndefined();
  });

  it("classifies account and capacity questions correctly", () => {
    expect(plan("Hvor fører jeg arbeidshansker?").intent).toBe("account_lookup");
    expect(
      plan("Har vi kapasitet i august? Ca 29.000 timer.").intent,
    ).toBe("staffing_capacity");
  });
});
