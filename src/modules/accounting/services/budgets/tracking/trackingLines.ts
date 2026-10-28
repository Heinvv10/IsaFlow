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
 * prints "—". A window reaching a year with NO version has no window budget
 * at all (every line "—", unallocated too); the monthly figures keep the
 * versioned months. An account included in some window months and only above
 * the filter in others (a grain change between versions) has no window budget
 * either, and is marked above the filter. A line is printed when it has a window actual, a window budget,
 * an FY* budget, a projection or unallocated budget: band and profit totals
 * (`trackingBands`) are sums of these lines, so a line left out would be a
 * figure missing from its band.
 */
import { log } from '@/lib/logger';
import { pctOfBudget } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { fromCents, toCents } from '../grid/cents';
import { bandOf } from '../grid/subtotals';
import type { BudgetRowClass } from './trackingDimRollup';
import { projectCents, type ProjectionPlan } from './trackingProjection';
import type { TrackingLine, TrackingMonth } from './trackingTypes';

/** An account the print order does not list: a read the service did not make consistently (a 500 after it is logged). */
export class TrackingOrderError extends Error {
  constructor(readonly accountId: string) {
    super(`tracking: account ${accountId} is missing from the print order`);
    this.name = 'TrackingOrderError';
  }
}

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

/** income: up is good; expense: down is good. */
export const isFavourable = (polarity: 'income' | 'expense', varianceCents: number): boolean =>
  (polarity === 'income' ? varianceCents >= 0 : varianceCents <= 0);

/** variance / |budget| × 100, null on a zero or absent budget: P0's `pctOfBudget` (a ratio, so cents in, the same %). */
export const pctOf = (varianceCents: number, budgetCents: number | null): number | null =>
  pctOfBudget(varianceCents, budgetCents ?? 0, budgetCents !== null);

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
  /** Window months in a year with no version: any of them makes the WINDOW budget absent on every line. */
  noVersionMonths?: readonly string[];
  /** Account ids in the order to print them (Postgres' `ORDER BY account_code`); absent, the order the cells arrive in. */
  order?: readonly string[];
}): TrackingLine[] {
  // A month nobody budgeted for (no version) is not a zero budget: a window total that silently
  // counted it as 0 would print a variance against part of the window.
  const windowBudgetAbsent = input.windowMonths.some((m) => input.noVersionMonths?.includes(m));
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
    // A grain change across versions (review A3): included rows in some window months and only
    // coarser ones in others is a budget for PART of the window, not the window's: absent, above
    // the filter. (A version holds one grain per account, so a month never has both.)
    const grainChanged = anyIn(acc.budget, ms) && ms.some((m) => acc.coarser.has(m) && !acc.budget.has(m));
    const budget = !windowBudgetAbsent && !grainChanged && anyIn(acc.budget, ms) ? sumOver(acc.budget, ms) : null;
    // Unallocated budget over a window with a no-version month is a partial-window sum too (A2): absent.
    const unallocated = windowBudgetAbsent ? null : sumOver(acc.coarser, ms);
    const variance = budget === null ? null : actual - budget;
    const proj = projectCents(acc.actual, anyIn(acc.budget, input.plan.fyMonths) ? acc.budget : null, input.plan);
    if (actual === 0 && budget === null && proj.fyBudget === null && proj.projected === 0 && !anyIn(acc.coarser, ms)) continue;

    const monthly: TrackingMonth[] = ms.map((month) => {
      const a = acc.actual.get(month) ?? 0;
      const bm = acc.budget.has(month) ? acc.budget.get(month)! : null;
      const v = bm === null ? null : a - bm;
      return {
        month, actual: fromCents(a), budget: bm === null ? null : fromCents(bm),
        budgetAboveFilter: bm === null && acc.coarser.has(month),
        variance: v === null ? null : fromCents(v), favourable: v === null ? null : isFavourable(polarity, v),
      };
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
      unallocatedBudget: unallocated === null ? null : fromCents(unallocated),
      budgetAboveFilter: (grainChanged || !anyIn(acc.budget, ms)) && anyIn(acc.coarser, ms),
      monthly,
    });
  }
  if (!input.order) return lines;
  const rank = new Map(input.order.map((id, i) => [id, i]));
  const at = (id: string) => {
    const i = rank.get(id);
    if (i === undefined) {
      const err = new TrackingOrderError(id);
      log.error(err.message, { accountId: id }, 'budgets');
      throw err;
    }
    return i;
  };
  return lines.sort((x, y) => at(x.accountId) - at(y.accountId));
}
