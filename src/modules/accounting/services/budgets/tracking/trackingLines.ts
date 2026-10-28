/**
 * Account lines of the tracking report from the two reads (budgets P3 spec
 * §2.1, §2.3, §2.4). Pure, and in integer cents until the last step.
 *
 * Inputs are what `trackingActualRead` and `trackingBudgetRead` return, the
 * budget cells already classified against the filter (`trackingDimRollup`):
 *   - included cells make the Budget column, the monthly budget and the
 *     projection;
 *   - coarser cells are the line's `unallocatedBudget` (window months only),
 *     never in the Budget column, never apportioned;
 *   - other cells are ignored.
 *
 * "Budgeted" is the PRESENCE of an included cell in the window (D5): a
 * deliberate zero budget prints 0 and its variance is the actual; no cell
 * prints "—". A line is printed when it has a window actual, a window budget,
 * an FY* budget, a projection or unallocated budget: band and profit totals
 * (`trackingBands`) are sums of these lines, so a line left out would be a
 * figure missing from its band.
 */
import { round2 } from '@/modules/accounting/services/core/budgetMonths';
import { expenseBand, revenueBand } from '@/modules/accounting/services/gl/accountClassification';
import type { BudgetRowClass } from './trackingDimRollup';
import { projectCents, type ProjectionPlan } from './trackingProjection';
import type { TrackingBandKey, TrackingLine, TrackingMonth } from './trackingTypes';

export interface AccountMeta {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: 'revenue' | 'expense';
  accountSubtype: string | null;
}

/** Posted movement for one account and calendar month, natural sign (revenue Cr − Dr, expense Dr − Cr). */
export interface ActualCell { accountId: string; month: string; amount: number }

export interface ClassifiedBudgetCell { accountId: string; month: string; amount: number; cls: BudgetRowClass }

export const toCents = (rand: number): number => {
  const c = Math.round(round2(rand) * 100);
  return c === 0 ? 0 : c;
};
export const fromCents = (cents: number): number => (cents === 0 ? 0 : cents / 100);

/** income: up is good; expense: down is good. */
export const isFavourable = (polarity: 'income' | 'expense', varianceCents: number): boolean =>
  (polarity === 'income' ? varianceCents >= 0 : varianceCents <= 0);

export const pctOf = (varianceCents: number, budgetCents: number | null): number | null =>
  (budgetCents === null || budgetCents === 0 ? null : (varianceCents / Math.abs(budgetCents)) * 100);

export function bandOf(type: 'revenue' | 'expense', subtype: string | null): TrackingBandKey {
  if (type === 'revenue') return revenueBand(subtype) === 'other_income' ? 'other_income' : 'turnover';
  switch (expenseBand(subtype)) {
    case 'cost_of_sales': return 'cost_of_sales';
    case 'other_expense': return 'other_expenses';
    default: return 'operating_expenses';
  }
}

interface Acc { actual: Map<string, number>; budget: Map<string, number>; coarser: Map<string, number> }

const add = (map: Map<string, number>, key: string, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);
const sumOver = (map: ReadonlyMap<string, number>, ms: readonly string[]) => ms.reduce((s, m) => s + (map.get(m) ?? 0), 0);
const anyIn = (map: ReadonlyMap<string, number>, ms: readonly string[]) => ms.some((m) => map.has(m));

export function buildTrackingLines(input: {
  accounts: ReadonlyMap<string, AccountMeta>;
  windowMonths: readonly string[];
  plan: ProjectionPlan;
  actuals: readonly ActualCell[];
  budgets: readonly ClassifiedBudgetCell[];
}): TrackingLine[] {
  const byAccount = new Map<string, Acc>();
  const accOf = (id: string): Acc => {
    let acc = byAccount.get(id);
    if (!acc) byAccount.set(id, (acc = { actual: new Map(), budget: new Map(), coarser: new Map() }));
    return acc;
  };
  for (const a of input.actuals) add(accOf(a.accountId).actual, a.month, toCents(a.amount));
  for (const b of input.budgets) {
    if (b.cls === 'included') add(accOf(b.accountId).budget, b.month, toCents(b.amount));
    else if (b.cls === 'coarser') add(accOf(b.accountId).coarser, b.month, toCents(b.amount));
  }

  const lines: TrackingLine[] = [];
  for (const [accountId, acc] of byAccount) {
    const meta = input.accounts.get(accountId);
    if (!meta) throw new Error(`tracking: no account metadata for ${accountId}`);
    const polarity = meta.accountType === 'revenue' ? 'income' : 'expense';
    const ms = input.windowMonths;
    const actual = sumOver(acc.actual, ms);
    const budget = anyIn(acc.budget, ms) ? sumOver(acc.budget, ms) : null;
    const unallocated = sumOver(acc.coarser, ms);
    const variance = budget === null ? null : actual - budget;
    const proj = projectCents(acc.actual, anyIn(acc.budget, input.plan.fyMonths) ? acc.budget : null, input.plan);
    if (actual === 0 && budget === null && proj.fyBudget === null && proj.projected === 0 && !anyIn(acc.coarser, ms)) continue;

    const monthly: TrackingMonth[] = ms.map((month) => {
      const a = acc.actual.get(month) ?? 0;
      const bm = acc.budget.has(month) ? acc.budget.get(month)! : null;
      const v = bm === null ? null : a - bm;
      return { month, actual: fromCents(a), budget: bm === null ? null : fromCents(bm), variance: v === null ? null : fromCents(v), favourable: v === null ? null : isFavourable(polarity, v) };
    });
    lines.push({
      accountId,
      accountCode: meta.accountCode,
      accountName: meta.accountName,
      accountType: meta.accountType,
      band: bandOf(meta.accountType, meta.accountSubtype),
      actual: fromCents(actual),
      budget: budget === null ? null : fromCents(budget),
      variance: variance === null ? null : fromCents(variance),
      variancePct: variance === null ? null : pctOf(variance, budget),
      favourable: variance === null ? null : isFavourable(polarity, variance),
      projected: fromCents(proj.projected),
      fyBudget: proj.fyBudget === null ? null : fromCents(proj.fyBudget),
      projVariance: proj.projVariance === null ? null : fromCents(proj.projVariance),
      projFavourable: proj.projVariance === null ? null : isFavourable(polarity, proj.projVariance),
      unallocatedBudget: fromCents(unallocated),
      budgetAboveFilter: budget === null && anyIn(acc.coarser, ms),
      monthly,
    });
  }
  return lines.sort((x, y) => (x.accountCode < y.accountCode ? -1 : x.accountCode > y.accountCode ? 1 : x.accountId < y.accountId ? -1 : 1));
}
