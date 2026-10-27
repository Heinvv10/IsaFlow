/**
 * The budget grid's live band totals, shared by the read model and the import preview so the two
 * cannot disagree: a line counts once, at company level (the sum of its dimension rows), and a
 * legacy header counts its OWN amounts once, never its roll-up (decision 18). Cents in, rand out.
 */
import type { CellKey } from './grid/cellKey';
import { fromCents } from './grid/cents';
import { foldBands, type BandTotals, type Metric } from './grid/subtotals';
import type { GridAccount } from './gridReadTypes';

/** An account the grid edits as a line: a leaf, or a legacy header holding its own amounts (decision 18). */
export const isBudgetLine = (a: GridAccount): boolean => !a.isHeader || a.ownAmounts;

/** Each account's own cents per year month (every dimension row summed); months outside the year are ignored. */
export function ownMonths(cells: Iterable<readonly [CellKey, number | null]>, monthKeys: readonly string[]): Map<string, number[]> {
  const monthIndex = new Map(monthKeys.map((m, i) => [m, i]));
  const own = new Map<string, number[]>();
  for (const [key, v] of cells) {
    if (v === null) continue;
    const i = monthIndex.get(key.slice(key.lastIndexOf('|') + 1));
    if (i === undefined) continue;
    const account = key.slice(0, key.indexOf('|'));
    const months = own.get(account) ?? Array<number>(monthKeys.length).fill(0);
    months[i] = (months[i] ?? 0) + v;
    own.set(account, months);
  }
  return own;
}

/** Band totals and GP / OP / NP per month and FY, in rand, over the budget lines of `accounts`. */
export function bandTotals(accounts: readonly GridAccount[], own: ReadonlyMap<string, number[]>, monthCount: number): BandTotals {
  const t = foldBands(accounts.filter(isBudgetLine), (a) => own.get(a.id) ?? [], monthCount);
  const months = Object.fromEntries(Object.entries(t.months).map(([k, v]) => [k, v.map(fromCents)])) as Record<Metric, number[]>;
  const fy = Object.fromEntries(Object.entries(t.fy).map(([k, v]) => [k, fromCents(v)])) as Record<Metric, number>;
  return { months, fy };
}
