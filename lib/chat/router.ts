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
  | "capabilities_help"
  | "clarification"
  | "account_lookup"
  | "account_list"
  | "project_list"
  | "project_summary"
  | "budget_lines"
  | "quantities"
  | "staffing_capacity"
  | "monthly_capacity"
  | "document_question"
  | "general_qa"
  | "follow_up"
  | "agent";

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

/**
 * Broad project-LIST phrasing ("hvilke prosjekter finnes/har vi/ligger inne/kan
 * du se", "vis/list (alle) prosjekter", "hva finnes av prosjekter"). This is a
 * list of every project, NOT a summary of one specific project — so it combines
 * Endre + local sources instead of preferring a single project's Endre record.
 */
const PROJECT_LIST_RE =
  /\bhvilke\s+prosjekter\b|\b(vis|list(?:e)?)\s+(?:meg\s+|alle\s+)?prosjekter\b|\bhva\s+finnes\s+av\s+prosjekter\b|\bprosjekter\s+(?:finnes|har\s+vi|ligger\s+inne|kan\s+du\s+se)\b/i;

/**
 * Broad account/chart-of-accounts LIST phrasing ("hvilke kontoer finnes/har vi",
 * "vis/list (alle) kontoer", "vis kontoplanen"). Distinct from an account LOOKUP
 * ("hva fører jeg X på?"): a list asks for the whole chart, so a truncation
 * warning is meaningful here, while a lookup answers with the closest account.
 */
const ACCOUNT_LIST_RE =
  /\bhvilke\s+kontoer\b|\b(vis|list(?:e)?)\s+(?:meg\s+|alle\s+)?(?:kontoer|kontoplanen?)\b|\bvis\s+kontoplan(?:en)?\b|\bkontoer\s+(?:finnes|har\s+vi)\b|\bhele\s+kontoplanen?\b/i;

/**
 * Lighter monthly signal applied ONLY to the new message of a follow-up after a
 * staffing/capacity turn. Once a capacity discussion is underway, a far weaker
 * hint flips the answer to a month-by-month view: a bare month name, a 4-digit
 * year, or "per måned"/"månedlig" — on top of the range phrases in MONTHLY_RE.
 *
 * Crucially this is NOT applied to the inherited prior question (which may say
 * "starter i august" without ever asking for a monthly breakdown) — only to
 * what the user just typed.
 */
const MONTHLY_FOLLOWUP_RE =
  /\b(fram\s+til|frem\s+til|til\s+og\s+med|t\.?o\.?m\.?|ut\s+(?:å|a)ret|hver\s+m(?:å|a)ned|per\s+m(?:å|a)ned|m(?:å|a)nedlig|hver\s+mnd|per\s+mnd|januar|january|februar|february|mars|march|april|mai|may|juni|june|juli|july|august|september|oktober|october|november|desember|december|20\d{2})\b/i;

function isMonthly(text: string): boolean {
  return MONTHLY_RE.test(text);
}

function isMonthlyFollowUp(text: string): boolean {
  return MONTHLY_FOLLOWUP_RE.test(text);
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
  /**
   * The raw new user message (only the latest turn), passed for follow-ups so a
   * lighter monthly signal — a bare month/year after a capacity turn — can flip
   * staffing_capacity to monthly_capacity without the inherited prior question
   * leaking false positives.
   */
  followUpMessage?: string,
): RouteDecision {
  const base = {
    searchTerms: [] as string[],
    boostDocumentNames: [] as string[],
    excludeDocumentNames: [] as string[],
    maxChunks: DEFAULT_MAX_CHUNKS,
    resolvedFromFollowUp,
  };

  // --- project_list ---------------------------------------------------------
  // A broad "which projects exist?" question. The orchestrator combines Endre
  // (live) and Firestore/local projects for this route, so both are allowed.
  if (PROJECT_LIST_RE.test(retrievalText)) {
    return {
      ...base,
      route: "project_list",
      allowedSources: ["projects"],
      excludedSources: ["accounts", "budgetLines", "quantities", "staffingPlan"],
      // A project list must not drag in the staffing plan or the chart of accounts.
      excludeDocumentNames: ["bemanning", "kontoplan", "chart of accounts"],
      answerFormat:
        "List prosjektene fra konteksten (feltet «projects») med prosjektnavn og " +
        "prosjektnummer slik de står. Dette er en samlet liste fra både Endre og " +
        "lokale prosjektdata. Ikke legg til vurderinger, fellestrekk eller " +
        "konto-/bemanningsdata, og ikke vis interne id-er.",
    };
  }

  // --- account_list ---------------------------------------------------------
  // A broad "which accounts exist?" / "vis kontoplanen" question. Unlike an
  // account lookup, this legitimately shows (part of) the whole chart, so a
  // truncation warning is allowed here.
  if (!intent.accountLookup && ACCOUNT_LIST_RE.test(retrievalText)) {
    return {
      ...base,
      route: "account_list",
      allowedSources: ["accounts"],
      excludedSources: ["projects", "budgetLines", "quantities", "staffingPlan"],
      searchTerms: ["kontoplan", "konto"],
      excludeDocumentNames: ["bemanning"],
      answerFormat:
        "List kontoene fra konteksten med kontonummer og kontonavn. Vises bare " +
        "deler av kontoplanen, si tydelig at det er et utvalg. Ikke ta med " +
        "prosjekt- eller bemanningsdata.",
    };
  }

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
    // A month-by-month rollup is requested either by the (combined) retrieval
    // text, OR — for a follow-up after a capacity turn — by a lighter signal in
    // just the new message ("Gi meg det du har frem til september 2026", or even
    // a bare month/year). The prior question is never scanned with the lighter
    // pattern, so "starter i august" alone never forces a monthly view.
    const monthly =
      isMonthly(retrievalText) ||
      (resolvedFromFollowUp &&
        typeof followUpMessage === "string" &&
        isMonthlyFollowUp(followUpMessage));
    // A *real* demand is hours or a role split — a bare month/year is NOT a
    // demand. Without one we must not produce a "behov vs differanse" analysis or
    // conclude that capacity is (in)sufficient; we only show available capacity.
    const hasRealDemand = Boolean(
      intent.capacityDemand &&
        (intent.capacityDemand.totalHours !== null ||
          intent.capacityDemand.roles.length > 0),
    );
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
          "tallene er hentet fra. Mangler tall for noen måneder INNENFOR den " +
          "etterspurte perioden, vis det du har og si hvilke av disse månedene som " +
          "mangler — omtal aldri måneder utenfor perioden som manglende, og ta dem " +
          "ikke med i svaret. Finnes ikke månedlig kapasitet i det hele " +
          "tatt, si at den mangler — ikke fyll inn nuller. " +
          (hasRealDemand
            ? "Et behov er oppgitt; du kan sammenligne tilgjengelig kapasitet mot det."
            : "Det er IKKE oppgitt et konkret behov, så ikke konkluder med at dere " +
              "«har kapasitet» eller mangler folk, og ikke vis «Behov per fag: 0» " +
              "eller «Differanse: 0» — vis kun tilgjengelig kapasitet.") +
          " Ikke ta med konto- eller prosjektdata.",
      };
    }
    if (!hasRealDemand) {
      // Capacity question without a quantified need (e.g. a clarification answer
      // "bemanning/kapasitet"): show available capacity only, never invent a need.
      return {
        ...shared,
        route: "staffing_capacity",
        answerFormat:
          "Vis tilgjengelig kapasitet per fag (og per måned der det finnes) fra " +
          "bemanningsplanen, med periode og kilde (dokument/ark). Det er IKKE " +
          "oppgitt et konkret behov å sammenligne mot, så ikke konkluder med at " +
          "dere «har kapasitet» eller mangler folk, og ikke vis «Behov per fag: 0» " +
          "eller «Differanse: 0». Vil brukeren ha en vurdering, be om behovet " +
          "(timer, fordeling, periode). Mangler tall, si nøyaktig hva som mangler. " +
          "Ikke ta med konto- eller prosjektdata.",
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
      excludedSources: ["staffingPlan", "accounts"],
      searchTerms: expandGlossaryTerms(retrievalText),
      // A project summary should not drag in the staffing plan or the chart of
      // accounts (kontoplan) unless the user explicitly asks for them.
      excludeDocumentNames: ["bemanning", "kontoplan", "chart of accounts"],
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
