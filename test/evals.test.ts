/**
 * Eval runner — drives the Norne eval set through the real routing/retrieval
 * pipeline WITHOUT calling OpenAI. Asserts route, allowed/excluded sources,
 * search-term expansion, parsed capacity demand, follow-up resolution and
 * account ranking.
 */

import { describe, expect, it } from "vitest";
import { resolveFollowUp } from "@/lib/chat/followup";
import { detectIntent } from "@/lib/chat/intent";
import { routeMessage } from "@/lib/chat/router";
import { rankAccounts } from "@/lib/chat/accountLookup";
import { EVAL_CASES, SAMPLE_ACCOUNTS } from "@/test/evals/norneQuestions";

/** Replicates the orchestrator's classification path (no Firestore/OpenAI). */
function classify(c: (typeof EVAL_CASES)[number]) {
  const followUp = resolveFollowUp(c.question, c.history ?? []);
  const intent = detectIntent(followUp.retrievalText);
  const decision = routeMessage(
    followUp.retrievalText,
    intent,
    followUp.isFollowUp,
  );
  return { followUp, intent, decision };
}

describe("Norne eval set", () => {
  for (const c of EVAL_CASES) {
    describe(c.name, () => {
      const { intent, decision } = classify(c);
      const exp = c.expect;

      it(`routes to ${exp.route}`, () => {
        expect(decision.route).toBe(exp.route);
      });

      if (exp.allowedSources) {
        it("allows the expected sources", () => {
          for (const s of exp.allowedSources!) {
            expect(decision.allowedSources).toContain(s);
          }
        });
      }

      if (exp.excludedSources) {
        it("excludes the wrong sources", () => {
          for (const s of exp.excludedSources!) {
            expect(decision.excludedSources).toContain(s);
            expect(decision.allowedSources).not.toContain(s);
          }
        });
      }

      if (exp.expandsTerms) {
        it("expands the search terms via the glossary", () => {
          const terms = decision.searchTerms.map((t) => t.toLowerCase());
          for (const t of exp.expandsTerms!) {
            expect(terms).toContain(t.toLowerCase());
          }
        });
      }

      if (exp.demandHours) {
        it("parses the per-role demand deterministically", () => {
          const byRole = Object.fromEntries(
            (intent.capacityDemand?.roles ?? []).map((r) => [r.role, r.hours]),
          );
          for (const [role, hours] of Object.entries(exp.demandHours!)) {
            expect(byRole[role]).toBe(hours);
          }
        });
      }

      if (exp.rankIncludesAccountNumber) {
        it("surfaces the right account in ranking", () => {
          const ranked = rankAccounts(SAMPLE_ACCOUNTS, intent.searchTerms, 12);
          const numbers = ranked.map((r) => String(r.account.number));
          expect(numbers).toContain(exp.rankIncludesAccountNumber);
        });
      }

      if (exp.resolvedFromFollowUp) {
        it("is recognised as a follow-up", () => {
          expect(decision.resolvedFromFollowUp).toBe(true);
        });
      }
    });
  }
});
