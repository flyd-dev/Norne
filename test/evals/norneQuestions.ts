/**
 * Norne evaluation set.
 *
 * Realistic questions paired with deterministic expectations about how the
 * pipeline should *route and retrieve* — NOT about the exact wording of the LLM
 * answer. These never call OpenAI: they exercise follow-up resolution, intent
 * detection, the router (route + allowed/excluded sources + search expansion),
 * capacity demand parsing, and account ranking.
 *
 * The runner lives in test/evals.test.ts. Add a case here whenever a bad answer
 * is discovered, so regressions are caught before they ship.
 */

import type { Route, SourceKind } from "@/lib/chat/router";
import type { CanonicalRole } from "@/lib/chat/roles";
import type { FirestoreDoc } from "@/lib/firestore/types";

export interface EvalExpectation {
  /** The route the question must resolve to. */
  route: Route;
  /** Sources that MUST be allowed (subset check). */
  allowedSources?: SourceKind[];
  /** Sources that MUST be excluded. */
  excludedSources?: SourceKind[];
  /** Search terms the expansion MUST include (lowercased substring match). */
  expandsTerms?: string[];
  /** Expected per-role demand hours parsed from the question. */
  demandHours?: Partial<Record<CanonicalRole, number>>;
  /** When set, the account chart ranking MUST surface this account number. */
  rankIncludesAccountNumber?: string;
  /** When true, the case must be recognised as a follow-up reference. */
  resolvedFromFollowUp?: boolean;
}

export interface EvalCase {
  name: string;
  question: string;
  history?: { role: "user" | "assistant"; content: string }[];
  expect: EvalExpectation;
}

/** A small representative chart of accounts for ranking assertions. */
export const SAMPLE_ACCOUNTS: FirestoreDoc[] = [
  { id: "a1", number: "4000", name: "Varekjøp" },
  { id: "a2", number: "6570", name: "Driftsmateriell og verneutstyr" },
  { id: "a3", number: "7140", name: "Reisekostnad" },
  { id: "a4", number: "5000", name: "Lønn" },
];

export const EVAL_CASES: EvalCase[] = [
  {
    name: "account lookup — arbeidshansker",
    question: "Hva fører jeg arbeidshansker på?",
    expect: {
      route: "account_lookup",
      allowedSources: ["accounts"],
      excludedSources: ["projects", "staffingPlan"],
      expandsTerms: ["verneutstyr", "driftsmateriell"],
      rankIncludesAccountNumber: "6570",
    },
  },
  {
    name: "account lookup — vernesko (PPE expansion)",
    question: "Hvor bokfører jeg vernesko?",
    expect: {
      route: "account_lookup",
      allowedSources: ["accounts"],
      excludedSources: ["projects", "staffingPlan"],
      expandsTerms: ["vernesko", "verneutstyr", "driftsmateriell"],
      rankIncludesAccountNumber: "6570",
    },
  },
  {
    name: "project summary — prosjekt 7100",
    question: "Oppsummer prosjekt 7100",
    expect: {
      route: "project_summary",
      allowedSources: ["projects"],
      excludedSources: ["staffingPlan"],
    },
  },
  {
    name: "staffing capacity — new project demand",
    question:
      "Vi starter nytt prosjekt i august. ca 29.000 timer. Fordeling 30% Stilfixer, 60% Carpenter og resterende welder. Har vi kapasitet?",
    expect: {
      route: "staffing_capacity",
      allowedSources: ["staffingPlan"],
      excludedSources: ["accounts", "projects"],
      demandHours: { "Steel fixer": 8700, Carpenter: 17400, Welder: 2900 },
    },
  },
  {
    name: "monthly capacity — per month for the rest of the year",
    question: "Kan du gi meg tilgjengelig kapasitet hver måned ut året?",
    expect: {
      route: "monthly_capacity",
      allowedSources: ["staffingPlan"],
      excludedSources: ["accounts", "projects"],
    },
  },
  {
    name: "follow-up — narrow monthly capacity to a period",
    question: "Gi meg det du har frem til september 2026",
    history: [
      {
        role: "user",
        content: "Kan du gi meg tilgjengelig kapasitet hver måned ut året?",
      },
      { role: "assistant", content: "Her er kapasiteten per måned …" },
    ],
    expect: {
      route: "monthly_capacity",
      allowedSources: ["staffingPlan"],
      excludedSources: ["accounts", "projects"],
      resolvedFromFollowUp: true,
    },
  },
];
