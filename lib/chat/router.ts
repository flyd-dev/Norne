/**
 * Intent router.
 *
 * Intent detection (lib/chat/intent.ts) decides *what the question is about*.
 * The router turns that into an explicit, named *route* with a fixed policy:
 * which data sources are allowed, which are excluded, what to search for, how
 * many document chunks to pull, and how the answer should be shaped.
 *
 * Centralising this is the whole point of the framework: instead of patching the
 * orchestrator every time a question type leaks the wrong source, each route's
 * policy lives here, is unit-tested, and the orchestrator just obeys it.
 *
 * Pure and dependency-free. The orchestrator decides how to fetch; this module
 * only classifies and configures.
 */

import type { DetectedIntent } from "@/lib/chat/intent";
import { expandGlossaryTerms } from "@/lib/chat/domainGlossary";

export type Route =
  | "account_lookup"
  | "project_summary"
  | "budget_lines"
  | "quantities"
  | "staffing_capacity"
  | "monthly_capacity"
  | "document_question"
  | "follow_up";

/** The data sources a route is allowed to read from. */
export type SourceKind =
  | "accounts"
  | "projects"
  | "budgetLines"
  | "quantities"
  | "documents"
  | "staffingPlan";

export interface RouteDecision {
  route: Route;
  /** Sources this route may use. */
  allowedSources: SourceKind[];
  /** Sources explicitly kept out (used both for gating and for documentation). */
  excludedSources: SourceKind[];
  /** Extra terms to expand the document/account search with. */
  searchTerms: string[];
  /** Document-name substrings to boost (e.g. "bemanning"). */
  boostDocumentNames: string[];
  /** Document-name substrings to exclude (e.g. "kontoplan"). */
  excludeDocumentNames: string[];
  /** Max document chunks to send to the model. */
  maxChunks: number;
  /** A short Norwegian note appended to the prompt to shape the answer. */
  answerFormat: string;
  /** True when this route was reached by resolving a short follow-up. */
  resolvedFromFollowUp: boolean;
}

/** Default chunk budgets — mirror lib/rag/documentSearch.ts. */
const DEFAULT_MAX_CHUNKS = 6;
const CAPACITY_MAX_CHUNKS = 16;

/** Staffing-plan boosts/excludes shared by both capacity routes. */
const STAFFING_BOOST_DOCS = ["bemanning"];
const STAFFING_EXCLUDE_DOCS = ["kontoplan", "chart of accounts"];

/**
 * Monthly-capacity phrasing: "tilgjengelig kapasitet hver måned", "per måned",
 * "månedlig", "ut året", "frem til september". Distinguishes a month-by-month
 * capacity rollup from a single "har vi kapasitet for dette prosjektet?" demand.
 */
const MONTHLY_RE =
  /\b(hver\s+m(?:å|a)ned|per\s+m(?:å|a)ned|m(?:å|a)nedlig|hver\s+mnd|per\s+mnd|ut\s+(?:å|a)ret|ut\s+m(?:å|a)neden|fram\s+til|frem\s+til|m(?:å|a)ned\s+for\s+m(?:å|a)ned)\b/i;

/** Project-summary phrasing ("oppsummer", "sammendrag", "fortell om", "status"). */
const SUMMARY_RE =
  /\b(oppsummer|oppsummering|sammendrag|summer\s+opp|fortell\s+om|status\s+(?:på|for))\b/i;

function isMonthly(text: string): boolean {
  return MONTHLY_RE.test(text);
}

/**
 * Classify a (follow-up-resolved) message + detected intent into one route with
 * its full policy. Priority order matters: account and capacity routes are the
 * ones that most often leaked the wrong source, so they win first.
 */
export function routeMessage(
  retrievalText: string,
  intent: DetectedIntent,
  resolvedFromFollowUp = false,
): RouteDecision {
  const base = {
    searchTerms: [] as string[],
    boostDocumentNames: [] as string[],
    excludeDocumentNames: [] as string[],
    maxChunks: DEFAULT_MAX_CHUNKS,
    resolvedFromFollowUp,
  };

  // --- account_lookup -------------------------------------------------------
  if (intent.accountLookup) {
    return {
      ...base,
      route: "account_lookup",
      allowedSources: ["accounts", "documents"],
      excludedSources: ["projects", "budgetLines", "quantities", "staffingPlan"],
      searchTerms: [...intent.searchTerms, "kontoplan", "konto"],
      // An account answer must never lean on the staffing plan.
      excludeDocumentNames: ["bemanning"],
      answerFormat:
        "Svar med den/de best passende kontoen(e) og kontonummer. Bruk KUN " +
        "kontonumre som faktisk står i konteksten — aldri finn på et kontonummer. " +
        "Finnes ikke det eksakte, oppgi nærmeste relevante konto og si at det er " +
        "et forslag. Ikke ta med prosjekt- eller bemanningsoppsummeringer.",
    };
  }

  // --- staffing_capacity / monthly_capacity ---------------------------------
  if (intent.capacity) {
    const monthly = isMonthly(retrievalText);
    const roleTerms = intent.capacityDemand?.roles.map((r) => r.role) ?? [];
    const monthTerm = intent.capacityDemand?.startMonth
      ? [intent.capacityDemand.startMonth]
      : [];
    const searchTerms = [
      "bemanningsplan",
      "kapasitet",
      "tilgjengelig",
      "timer",
      "rotasjonsplan",
      ...roleTerms,
      ...monthTerm,
    ];
    const shared = {
      ...base,
      allowedSources: ["staffingPlan", "documents"] as SourceKind[],
      excludedSources: [
        "accounts",
        "projects",
        "budgetLines",
        "quantities",
      ] as SourceKind[],
      searchTerms,
      boostDocumentNames: STAFFING_BOOST_DOCS,
      excludeDocumentNames: STAFFING_EXCLUDE_DOCS,
      maxChunks: CAPACITY_MAX_CHUNKS,
    };
    if (monthly) {
      return {
        ...shared,
        route: "monthly_capacity",
        answerFormat:
          "List tilgjengelig kapasitet per måned (og per fag der det finnes) fra " +
          "bemanningsplanen. Oppgi alltid hvilken periode og hvilket dokument/ark " +
          "tallene er hentet fra. Finnes bare deler av perioden, vis det du har og " +
          "si hvilke måneder som mangler. Ikke ta med konto- eller prosjektdata.",
      };
    }
    return {
      ...shared,
      route: "staffing_capacity",
      answerFormat:
        "Vis behov per fag i timer, tilgjengelig kapasitet per fag fra " +
        "bemanningsplanen, og differansen. Konkluder tydelig om dere har " +
        "kapasitet eller mangler timer/folk. Oppgi periode og kilde (dokument/ark). " +
        "Mangler tall, si nøyaktig hva som mangler. Ikke ta med konto- eller " +
        "prosjektdata.",
    };
  }

  // --- budget_lines ---------------------------------------------------------
  if (intent.topics.includes("budgetLines")) {
    return {
      ...base,
      route: "budget_lines",
      allowedSources: ["projects", "budgetLines", "documents"],
      excludedSources: ["accounts", "staffingPlan"],
      searchTerms: expandGlossaryTerms(retrievalText),
      answerFormat:
        "Svar om budsjettlinjene for det aktuelle prosjektet. Mangler prosjekt, " +
        "be om hvilket prosjekt det gjelder og list tilgjengelige prosjekter.",
    };
  }

  // --- quantities -----------------------------------------------------------
  if (intent.topics.includes("quantities")) {
    return {
      ...base,
      route: "quantities",
      allowedSources: ["projects", "quantities", "documents"],
      excludedSources: ["accounts", "staffingPlan"],
      searchTerms: expandGlossaryTerms(retrievalText),
      answerFormat:
        "Svar om mengdene for det aktuelle prosjektet. Mangler prosjekt, be om " +
        "hvilket prosjekt det gjelder og list tilgjengelige prosjekter.",
    };
  }

  // --- project_summary ------------------------------------------------------
  if (intent.topics.includes("projects") || SUMMARY_RE.test(retrievalText)) {
    return {
      ...base,
      route: "project_summary",
      allowedSources: ["projects", "documents"],
      excludedSources: ["staffingPlan"],
      searchTerms: expandGlossaryTerms(retrievalText),
      // A project summary should not drag in the staffing plan unless asked.
      excludeDocumentNames: ["bemanning"],
      answerFormat:
        "Oppsummer prosjektet kun ut fra prosjektdataene i konteksten. Ikke ta " +
        "med urelaterte dokumenter eller bemanningsplanen med mindre brukeren ber " +
        "om det. Vis prosjektnavn og -nummer, ikke interne id-er.",
    };
  }

  // --- document_question (fallback) -----------------------------------------
  return {
    ...base,
    route: "document_question",
    allowedSources: ["documents", "accounts", "projects"],
    excludedSources: [],
    searchTerms: expandGlossaryTerms(retrievalText),
    answerFormat:
      "Svar ut fra de mest relevante opplastede dokumentene og dataene i " +
      "konteksten. Nevn hvilket dokument svaret er hentet fra.",
  };
}
