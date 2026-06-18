/**
 * Capacity tools — getMonthlyCapacity / getAvailableCapacity.
 *
 * These are the deterministic capacity facts the model reasons over. They read
 * canonical CapacityRow[] (structured tables first, text chunks as fallback),
 * honour an inclusive Norwegian range ("frem til september 2026" = up to AND
 * including September), and return per-fag figures with explicit coverage. The
 * model never sees raw cells, so it can't reverse a range or drop a month.
 */

import {
  parseAnyMonth,
  isMonthInBound,
  type MonthBound,
} from "@/lib/chat/dateRange";
import { CANONICAL_ROLES, type CanonicalRole } from "@/lib/chat/roles";
import type {
  CapacityRow,
  MonthlyCapacity,
} from "@/lib/assistant/domain/capacity";
import {
  capacityRowsFromTables,
  capacityRowsFromText,
} from "@/lib/assistant/ingestion/capacity";
import {
  ok,
  none,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@/lib/assistant/tools/registry";

export interface CapacityScope {
  /** Inclusive range bound, when the question stated one. */
  bound?: MonthBound | null;
  /** Restrict to a single canonical role, when asked. */
  role?: CanonicalRole | null;
}

/** Load + normalize CapacityRow[] for the request. Prefers the canonical
 * pre-normalized accessor, then structured tables, then text chunks. */
async function loadCapacityRows(ctx: ToolContext): Promise<CapacityRow[]> {
  if (ctx.getCapacityRows) {
    const rows = await ctx.getCapacityRows();
    if (rows.length > 0) return rows;
  }
  const tables = ctx.getStructuredTables ? await ctx.getStructuredTables() : [];
  const fromTables = capacityRowsFromTables(tables);
  if (fromTables.length > 0) return fromTables;
  return capacityRowsFromText(ctx.documentMatches ?? []);
}

/** Keep only rows inside the scope (range + role). */
function applyScope(rows: CapacityRow[], scope: CapacityScope): CapacityRow[] {
  return rows.filter((row) => {
    if (scope.role && row.role !== scope.role) return false;
    if (scope.bound) {
      const parsed = parseAnyMonth(row.month);
      if (!parsed || !isMonthInBound(parsed, scope.bound)) return false;
    }
    return true;
  });
}

/** Roll CapacityRow[] up into ordered MonthlyCapacity[] (first-seen order). */
function rollUpByMonth(rows: CapacityRow[]): MonthlyCapacity[] {
  const order: string[] = [];
  const map = new Map<string, MonthlyCapacity>();
  for (const row of rows) {
    let entry = map.get(row.month);
    if (!entry) {
      entry = { month: row.month, byRole: {}, total: 0 };
      map.set(row.month, entry);
      order.push(row.month);
    }
    // First value per (month, role) wins (overlap-safe).
    if (entry.byRole[row.role] === undefined) {
      entry.byRole[row.role] = row.availableHours;
      entry.total += row.availableHours;
    }
  }
  return order.map((m) => map.get(m)!);
}

function sourcesOf(rows: CapacityRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    set.add(r.sheet ? `${r.source} (${r.sheet})` : r.source);
  }
  return [...set];
}

// --- getMonthlyCapacity ----------------------------------------------------

export interface MonthlyCapacityOutput {
  months: MonthlyCapacity[];
  scope: CapacityScope;
}

export const getMonthlyCapacity: Tool<CapacityScope, MonthlyCapacityOutput> = {
  name: "getMonthlyCapacity",
  description:
    "Tilgjengelig kapasitet per fag per måned fra bemanningsplanen. Bruk for " +
    "spørsmål om månedsfordeling eller en periode (f.eks. «frem til september 2026»).",
  validate: (raw) => {
    const input = (raw ?? {}) as CapacityScope;
    return { ok: true, input };
  },
  async run(scope, ctx): Promise<ToolResult<MonthlyCapacityOutput>> {
    const all = await loadCapacityRows(ctx);
    if (all.length === 0) {
      return none(
        "Ingen tilgjengelig kapasitet per måned i bemanningsplanen eller dokumentutdragene.",
      );
    }
    const scoped = applyScope(all, scope);
    const sources = sourcesOf(scoped.length > 0 ? scoped : all);
    if (scoped.length === 0) {
      // Data exists, but none inside the requested range/role.
      return {
        data: { months: [], scope },
        sources,
        coverage: "partial",
        note: "Det finnes kapasitetstall, men ingen innenfor den etterspurte perioden/fagene.",
      };
    }
    return ok({ months: rollUpByMonth(scoped), scope }, sources);
  },
};

// --- getAvailableCapacity --------------------------------------------------

export interface AvailableCapacityOutput {
  byRole: Partial<Record<CanonicalRole, number>>;
  total: number;
  scope: CapacityScope;
}

export const getAvailableCapacity: Tool<CapacityScope, AvailableCapacityOutput> = {
  name: "getAvailableCapacity",
  description:
    "Total tilgjengelig kapasitet per fag (summert over perioden) fra " +
    "bemanningsplanen. Bruk for «har vi kapasitet»-spørsmål uten månedsfordeling.",
  validate: (raw) => ({ ok: true, input: (raw ?? {}) as CapacityScope }),
  async run(scope, ctx): Promise<ToolResult<AvailableCapacityOutput>> {
    const all = await loadCapacityRows(ctx);
    if (all.length === 0) {
      return none("Ingen tilgjengelig kapasitet i bemanningsplanen eller dokumentutdragene.");
    }
    const scoped = applyScope(all, scope);
    const sources = sourcesOf(scoped.length > 0 ? scoped : all);
    if (scoped.length === 0) {
      return {
        data: { byRole: {}, total: 0, scope },
        sources,
        coverage: "partial",
        note: "Det finnes kapasitetstall, men ingen innenfor den etterspurte perioden/fagene.",
      };
    }
    const byRole: Partial<Record<CanonicalRole, number>> = {};
    let total = 0;
    for (const row of scoped) {
      byRole[row.role] = (byRole[row.role] ?? 0) + row.availableHours;
      total += row.availableHours;
    }
    // Round to 2 decimals to avoid float dust (31.5 + 31.5 → 63, not 63.0000001).
    for (const role of CANONICAL_ROLES) {
      if (byRole[role] !== undefined) byRole[role] = Math.round(byRole[role]! * 100) / 100;
    }
    return ok({ byRole, total: Math.round(total * 100) / 100, scope }, sources);
  },
};
