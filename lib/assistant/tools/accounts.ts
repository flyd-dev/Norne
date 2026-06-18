/**
 * Account tools — searchChartOfAccounts / getAccountForPurchase.
 *
 * Wrap the existing account-lookup logic (term expansion + ranking) behind the
 * tool contract. They rank the chart-of-accounts rows the runner supplies and
 * return the top matches with their score; coverage is "none" when nothing
 * matches, so the model asks instead of guessing an account.
 */

import {
  expandSearchTerms,
  rankAccounts,
  type RankedAccount,
} from "@/lib/chat/accountLookup";
import {
  ok,
  none,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@/lib/assistant/tools/registry";

const MAX_ACCOUNTS = 8;

export interface AccountQueryInput {
  /** Free text: a search query or the thing being purchased. */
  query: string;
}

function run(
  terms: string[],
  ctx: ToolContext,
): ToolResult<RankedAccount[]> {
  const accounts = ctx.accounts ?? [];
  if (accounts.length === 0) {
    return none("Ingen kontoplan tilgjengelig.");
  }
  const ranked = rankAccounts(accounts, terms, MAX_ACCOUNTS);
  if (ranked.length === 0) {
    return none("Fant ingen konto som matcher.", ["accounts"]);
  }
  return ok(ranked, ["accounts"]);
}

export const searchChartOfAccounts: Tool<AccountQueryInput, RankedAccount[]> = {
  name: "searchChartOfAccounts",
  description: "Søk i kontoplanen etter konto som matcher et fritekstsøk.",
  validate: (raw) => {
    const input = raw as Partial<AccountQueryInput> | null;
    if (!input || typeof input.query !== "string" || input.query.trim() === "") {
      return { ok: false, error: "query is required" };
    }
    return { ok: true, input: { query: input.query } };
  },
  async run(input, ctx) {
    return run(expandSearchTerms(input.query), ctx);
  },
};

export const getAccountForPurchase: Tool<AccountQueryInput, RankedAccount[]> = {
  name: "getAccountForPurchase",
  description:
    "Foreslå riktig konto for et innkjøp («Hva fører jeg X på?»). Utvider X med " +
    "relaterte regnskapsbegreper før ranking.",
  validate: searchChartOfAccounts.validate,
  async run(input, ctx) {
    // expandSearchTerms covers both a bare subject and a full purchase phrase.
    return run(expandSearchTerms(input.query), ctx);
  },
};
