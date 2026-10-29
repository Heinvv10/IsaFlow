/**
 * computeVersion guards (PR-1 review round 1): ONE half-away rounding from the
 * exact ratio to the unit (never cents-then-unit), SECTION_EMPTY / BASE_MISSING
 * warnings, the per_head headcount guard, percent bounds (NUMERIC(9,4),
 * growth >= -100%), and stale driver cells re-sourced 'manual' (overrides stay).
 */
import { describe, it, expect } from 'vitest';
import { assertDriverMonths, computeVersion, monthIndex, type ComputeInput } from '@/modules/accounting/services/budgets/drivers/driverEngine';
import {
  DriverRangeError, DriverRefError, rowKeyFor,
  type Cell, type CellSource, type DriverDef, type DriverRow, type RowKey,
} from '@/modules/accounting/services/budgets/drivers/driverTypes';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';

const FY = ['2026-03', '2026-04', '2026-05', '2026-06'];
const ALL = { fromMonth: '2026-03', toMonth: '2026-06' };

function row(acct: string, band: Band): DriverRow {
  const ref = { glAccountId: acct, cc1Id: null, cc2Id: null, buId: null };
  return { key: rowKeyFor(ref), ...ref, band };
}
const SALES = row('sales', 'turnover');
const COGS = row('cogs', 'cost_of_sales');
const RENT = row('rent', 'operating_expense');

const flat = (amount: number, source: CellSource = 'manual', months = FY): Cell[] => months.map(month => ({ month, amount, source }));

function run(over: Partial<ComputeInput> & Pick<ComputeInput, 'drivers'>) {
  return computeVersion({
    months: FY, rows: [SALES, COGS, RENT], cells: new Map(), headcount: () => 0,
    closedMonths: new Set(), rounding: 1, ...over,
  });
}
const firstOf = (ref: number, pct: number, rounding: RoundingUnit): number | undefined => {
  const cells = new Map([[SALES.key, flat(ref)]]);
  const d: DriverDef = { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct, ...ALL };
  return run({ cells, drivers: [d], rounding }).writes[0]?.amount;
};

describe('one rounding, exact ratio straight to the unit', () => {
  it.each([
    // [ref cents, pct, unit, expected]: the exact value sits just under .5 of a unit; cents-first would round up.
    [299, 50, 1, 100], // R1.495 → R1 (cents-first: 150c → R2)
    [9999, 0.5, 1, 0], // R0.49995 → R0 (cents-first: 50c → R1)
    [29999, 50, 100, 10000], // R149.995 → R100 (cents-first: R150 → R200)
    [299999, 50, 1000, 100000], // R1499.995 → R1000 (cents-first: R1500 → R2000)
  ] as const)('ref %i cents × %s pct at unit R%i → %i cents, both signs', (ref, pct, unit, expected) => {
    expect(firstOf(ref, pct, unit)).toBe(expected);
    expect(firstOf(-ref, pct, unit)).toBe(expected === 0 ? 0 : -expected);
  });

  it.each([[1, 300, 200], [100, 30000, 20000], [1000, 300000, 200000]] as const)(
    'an exact half unit rounds away from zero at R%i', (unit, ref, expected) => {
      expect(firstOf(ref, 50, unit)).toBe(expected);
      expect(firstOf(-ref, 50, unit)).toBe(-expected);
    });
});

describe('missing-input warnings', () => {
  it('SECTION_EMPTY: a section with no amount reads 0 and warns once', () => {
    const d: DriverDef = { kind: 'pct_of_section', rowKey: RENT.key, section: 'turnover', scope: 'company', pct: 10, ...ALL };
    const cells = new Map([[SALES.key, flat(100000, 'manual', ['2026-03'])]]);
    const { writes, warnings } = run({ cells, drivers: [d] });
    expect(writes.map(w => w.amount)).toEqual([10000, 0, 0, 0]);
    expect(warnings).toEqual([expect.objectContaining({ code: 'SECTION_EMPTY', rowKey: RENT.key })]);
    expect(warnings[0]?.message).toContain('2026-04, 2026-05, 2026-06');
  });

  it('BASE_MISSING: a growth base with no amount reads 0 and warns once', () => {
    const d: DriverDef = { kind: 'growth', rowKey: SALES.key, pct: 5, baseMonth: '2026-03', fromMonth: '2026-04', toMonth: '2026-06' };
    const { writes, warnings } = run({ drivers: [d] });
    expect(writes.map(w => w.amount)).toEqual([0, 0, 0]);
    expect(warnings).toEqual([expect.objectContaining({ code: 'BASE_MISSING', rowKey: SALES.key })]);
  });
});

describe('refusals', () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('per_head refuses headcount %s', heads => {
    const d: DriverDef = { kind: 'per_head', rowKey: RENT.key, amount: 100, headcountScope: null, ...ALL };
    expect(() => run({ drivers: [d], headcount: () => heads })).toThrow(DriverRangeError);
  });

  it('growth below -100% and any percent beyond NUMERIC(9,4) are refused; the bounds pass', () => {
    const growth = (pct: number): DriverDef => ({ kind: 'growth', rowKey: SALES.key, pct, baseMonth: '2026-03', fromMonth: '2026-04', toMonth: '2026-06' });
    const line = (pct: number): DriverDef => ({ kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct, ...ALL });
    expect(() => run({ drivers: [growth(-100.0001)] })).toThrow(DriverRefError);
    expect(() => run({ drivers: [growth(-100)] })).not.toThrow();
    expect(() => run({ drivers: [line(100000)] })).toThrow(DriverRefError);
    expect(() => run({ drivers: [line(-100000)] })).toThrow(DriverRefError);
    expect(() => run({ drivers: [line(99999.9999)] })).not.toThrow();
    const section: DriverDef = { kind: 'pct_of_section', rowKey: RENT.key, section: 'turnover', scope: 'company', pct: 100000, ...ALL };
    expect(() => run({ drivers: [section] })).toThrow(DriverRefError);
  });
});

describe('stale driver cells are re-sourced manual, value kept; overrides stay', () => {
  it('driver removed: every driver cell of the row becomes manual; an override stays an override', () => {
    const cells = new Map<RowKey, Cell[]>([[RENT.key, [
      { month: '2026-03', amount: 500, source: 'driver' }, { month: '2026-04', amount: 700, source: 'override' },
      { month: '2026-05', amount: 900, source: 'manual' }, { month: '2026-06', amount: 1100, source: 'actual' }]]]);
    expect(run({ cells, drivers: [] }).writes).toEqual([
      { rowKey: RENT.key, month: '2026-03', amount: 500, source: 'manual' },
    ]);
  });

  it('range shrunk: driver cells outside [from, to] become manual after the row\'s driver writes; the override stays', () => {
    const cells = new Map<RowKey, Cell[]>([[RENT.key, [
      { month: '2026-03', amount: 500, source: 'override' }, ...flat(1000, 'driver', ['2026-04', '2026-05', '2026-06'])]]]);
    const d: DriverDef = { kind: 'fixed', rowKey: RENT.key, amount: 2000, fromMonth: '2026-05', toMonth: '2026-05' };
    expect(run({ cells, drivers: [d] }).writes).toEqual([
      { rowKey: RENT.key, month: '2026-05', amount: 2000, source: 'driver' },
      { rowKey: RENT.key, month: '2026-04', amount: 1000, source: 'manual' },
      { rowKey: RENT.key, month: '2026-06', amount: 1000, source: 'manual' },
    ]);
  });

  it('shrinking a range and growing it back never resets an override (spec §1.2)', () => {
    const cells = new Map<RowKey, Cell[]>([[RENT.key, [
      { month: '2026-03', amount: 999900, source: 'override' }, { month: '2026-04', amount: 100, source: 'driver' }]]]);
    const shrunk: DriverDef = { kind: 'fixed', rowKey: RENT.key, amount: 100, fromMonth: '2026-04', toMonth: '2026-04' };
    expect(run({ cells, drivers: [shrunk] }).writes).toEqual([]);
    const regrown: DriverDef = { ...shrunk, fromMonth: '2026-03' };
    expect(run({ cells, drivers: [regrown] }).writes).toEqual([]);
  });

  it('a driver whose rounding unit is not R1/R100/R1000 is refused at save', () => {
    const index = monthIndex(FY);
    expect(() => assertDriverMonths(index, { kind: 'fixed', rowKey: RENT.key, amount: 100, rounding: 7 as never, ...ALL }))
      .toThrow(DriverRefError);
    expect(() => assertDriverMonths(index, { kind: 'fixed', rowKey: RENT.key, amount: 100, rounding: 1000, ...ALL })).not.toThrow();
  });

  it('a closed month is never re-sourced; a re-run after re-sourcing writes nothing', () => {
    const cells = new Map<RowKey, Cell[]>([[RENT.key, flat(500, 'driver')]]);
    const first = run({ cells, drivers: [], closedMonths: new Set(['2026-03']) });
    expect(first.writes.map(w => w.month)).toEqual(['2026-04', '2026-05', '2026-06']);
    const after = new Map<RowKey, Cell[]>([[RENT.key, [{ month: '2026-03', amount: 500, source: 'driver' },
      ...first.writes.map(w => ({ month: w.month, amount: w.amount, source: w.source }))]]]);
    expect(run({ cells: after, drivers: [], closedMonths: new Set(['2026-03']) }).writes).toEqual([]);
  });
});

describe('frozen rows (headcount refreshes on demand)', () => {
  it('a frozen row keeps its cells, is not re-sourced, and feeds its dependents as it stands', () => {
    const cells = new Map<RowKey, Cell[]>([[RENT.key, flat(70000, 'driver')]]);
    const perHead: DriverDef = { kind: 'per_head', rowKey: RENT.key, amount: 10000, headcountScope: null, ...ALL };
    const heads = { headcount: () => 3 };
    expect(run({ cells, drivers: [perHead], ...heads, frozenRows: new Set([RENT.key]) }).writes).toEqual([]);
    expect(run({ cells, drivers: [], frozenRows: new Set([RENT.key]) }).writes).toEqual([]);
    expect(run({ cells, drivers: [perHead], ...heads }).writes.map(w => w.amount)).toEqual(FY.map(() => 30000));
    // A dependent reads the frozen row's STORED cells (R700), not its computed value (R300) or nothing.
    const half: DriverDef = { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: RENT.key, pct: 50, ...ALL };
    const out = run({ cells, drivers: [perHead, half], ...heads, frozenRows: new Set([RENT.key]) }).writes;
    expect(out.filter(w => w.rowKey === COGS.key).map(w => w.amount)).toEqual(FY.map(() => 35000));
    expect(out.some(w => w.rowKey === RENT.key)).toBe(false);
  });

  it('a frozen key that is not a row is refused like every unknown key', () => {
    expect(() => run({ drivers: [], frozenRows: new Set(['nope|||']) })).toThrow(DriverRefError);
  });
});
