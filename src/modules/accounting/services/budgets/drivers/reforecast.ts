/**
 * planReforecast (P4 spec §1.3, §4, §5): the full cell set of a reforecast
 * (or a rolling-forecast re-roll) from its source version and the actuals.
 * Pure: the service reads P3's `readTrackingActuals` four times (groupBy
 * null / 'cc1' / 'cc2' / 'bu'), converts amounts to cents and passes them in.
 *
 * - Each account keeps the grain of its source rows (company when it has none).
 * - Closed months: every row gets source 'actual' = the actual at its grain
 *   (0 when none). An actual for an account + member with no source row makes a
 *   new row at that grain, with closed-month cells only. At a dimension grain an
 *   untagged actual (memberId null) is UNPLACED: summed per account + month and
 *   reported, never dropped and never put on a company row (decision 4).
 * - Open months: the source cell, source kept.
 * - Then computeVersion runs over the result and its writes are applied, so a
 *   growth or % driver in an open month feeds off closed-month actuals.
 */
import { grainOf } from '@/modules/accounting/services/budgets/grid/cellKey';
import { isCents, type RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';
import { computeVersion, monthIndex } from './driverEngine';
import {
  DriverRangeError, DriverRefError, rowKeyFor,
  type Cell, type DriverDef, type DriverRow, type DriverWarning, type HeadcountFn, type RowKey,
} from './driverTypes';

type Level = 'company' | 'cc1' | 'cc2' | 'bu';
const LEVELS: readonly Level[] = ['company', 'cc1', 'cc2', 'bu'];

export interface ReforecastActual {
  accountId: string;
  /** 'YYYY-MM' */
  month: string;
  /** The member at the list's level; null = untagged (always null in the company list). */
  memberId: string | null;
  /** Integer cents, budget sign convention. */
  amount: number;
}

export type ReforecastActuals = Readonly<Record<Level, readonly ReforecastActual[]>>;

export interface ReforecastInput {
  months: readonly string[];
  /** The source version's rows. */
  rows: readonly DriverRow[];
  sourceCells: ReadonlyMap<RowKey, readonly Cell[]>;
  actuals: ReforecastActuals;
  closedMonths: ReadonlySet<string>;
  drivers: readonly DriverDef[];
  headcount: HeadcountFn;
  rounding: RoundingUnit;
  /** The band of an account that has no source row (a new actual-only row). */
  accountBand: (accountId: string) => Band;
}

export interface UnplacedActual {
  accountId: string;
  month: string;
  amount: number;
}

export interface ReforecastResult {
  /** Source rows, then rows created for actuals (sorted by key). */
  rows: DriverRow[];
  /** Every row's cells in month order. */
  cells: Map<RowKey, Cell[]>;
  unplaced: UnplacedActual[];
  warnings: DriverWarning[];
}

function accountGrains(rows: readonly DriverRow[]): Map<string, Level> {
  const out = new Map<string, Level>();
  for (const r of rows) {
    const g = grainOf(r);
    if (g === 'multi') throw new DriverRefError(`Row ${r.key} sets more than one dimension (grain)`, r.key);
    const seen = out.get(r.glAccountId);
    if (seen !== undefined && seen !== g) {
      throw new DriverRefError(`Account ${r.glAccountId} is budgeted at two grains (${seen}, ${g})`, r.key);
    }
    out.set(r.glAccountId, g);
  }
  return out;
}

function rowAt(accountId: string, level: Level, memberId: string | null, band: Band): DriverRow {
  const ref = {
    glAccountId: accountId,
    cc1Id: level === 'cc1' ? memberId : null,
    cc2Id: level === 'cc2' ? memberId : null,
    buId: level === 'bu' ? memberId : null,
  };
  return { key: rowKeyFor(ref), ...ref, band };
}

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

function addTo(map: Map<string, number>, key: string, amount: number, rowKey: RowKey, month: string): void {
  if (!isCents(amount)) throw new DriverRangeError(`Actual ${amount} for ${rowKey} ${month} is not whole cents in range`, rowKey, month);
  const sum = (map.get(key) ?? 0) + amount;
  if (!isCents(sum)) throw new DriverRangeError(`Actuals for ${rowKey} ${month} exceed the budget range`, rowKey, month);
  map.set(key, sum);
}

export function planReforecast(input: ReforecastInput): ReforecastResult {
  const index = monthIndex(input.months);
  const grains = accountGrains(input.rows);
  const sourceRows = new Map(input.rows.map(r => [r.key, r]));
  const isClosed = (m: string) => index.has(m) && input.closedMonths.has(m);

  // Closed-month actuals, placed at each account's grain.
  const placed = new Map<RowKey, Map<string, number>>();
  const created = new Map<RowKey, DriverRow>();
  const unplaced = new Map<string, number>();
  for (const level of LEVELS) {
    for (const a of input.actuals[level]) {
      if (!isClosed(a.month) || (grains.get(a.accountId) ?? 'company') !== level) continue;
      if (level !== 'company' && a.memberId === null) {
        addTo(unplaced, `${a.accountId}|${a.month}`, a.amount, a.accountId, a.month);
        continue;
      }
      const row = rowAt(a.accountId, level, level === 'company' ? null : a.memberId, input.accountBand(a.accountId));
      if (!sourceRows.has(row.key) && !created.has(row.key)) created.set(row.key, row);
      const byMonth = placed.get(row.key) ?? new Map<string, number>();
      placed.set(row.key, byMonth);
      addTo(byMonth, a.month, a.amount, row.key, a.month);
    }
  }

  const rows = [...input.rows, ...[...created.values()].sort((x, y) => cmp(x.key, y.key))];
  const grid = new Map<RowKey, Map<string, Cell>>(rows.map(r => [r.key, new Map()]));
  for (const [key, list] of input.sourceCells) {
    const own = grid.get(key);
    if (!own) throw new DriverRefError(`Source cells for unknown row ${key}`, key);
    for (const c of list) {
      if (!index.has(c.month)) throw new DriverRefError(`Row ${key}: source cell month ${c.month} is outside the version`, key);
      if (own.has(c.month)) throw new DriverRefError(`Row ${key}: two source cells for ${c.month}`, key);
      if (!isClosed(c.month)) own.set(c.month, { month: c.month, amount: c.amount, source: c.source });
    }
  }
  for (const r of rows) {
    const own = grid.get(r.key) as Map<string, Cell>;
    for (const month of input.months) {
      if (isClosed(month)) own.set(month, { month, amount: placed.get(r.key)?.get(month) ?? 0, source: 'actual' });
    }
  }

  const ordered = (own: Map<string, Cell>): Cell[] => input.months.flatMap(m => { const c = own.get(m); return c ? [c] : []; });
  const pre = new Map<RowKey, Cell[]>(rows.map(r => [r.key, ordered(grid.get(r.key) as Map<string, Cell>)]));
  const { writes, warnings } = computeVersion({
    months: input.months, rows, cells: pre, drivers: input.drivers,
    headcount: input.headcount, closedMonths: input.closedMonths, rounding: input.rounding,
  });
  for (const w of writes) grid.get(w.rowKey)?.set(w.month, { month: w.month, amount: w.amount, source: w.source });

  const cells = new Map<RowKey, Cell[]>(rows.map(r => [r.key, ordered(grid.get(r.key) as Map<string, Cell>)]));
  const unplacedList = [...unplaced.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([k, amount]) => {
      const cut = k.lastIndexOf('|');
      return { accountId: k.slice(0, cut), month: k.slice(cut + 1), amount };
    })
    .sort((x, y) => cmp(x.accountId, y.accountId) || (index.get(x.month) as number) - (index.get(y.month) as number));
  return { rows, cells, unplaced: unplacedList, warnings };
}
