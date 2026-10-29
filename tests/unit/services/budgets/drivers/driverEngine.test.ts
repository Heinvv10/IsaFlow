/**
 * computeVersion (P4 spec §4, §9): each kind's arithmetic in integer cents,
 * growth compounds, the driver range bounds every write, override / actual /
 * closed cells are never written, downstream rows read effective values, a
 * missing ref reads 0 with one warning, unchanged input yields no writes.
 */
import { describe, it, expect } from 'vitest';
import { computeVersion, type ComputeInput } from '@/modules/accounting/services/budgets/drivers/driverEngine';
import {
  DriverCycleError, DriverRangeError, DriverRefError, rowKeyFor,
  type Cell, type CellSource, type DriverDef, type DriverRow, type RowKey,
} from '@/modules/accounting/services/budgets/drivers/driverTypes';
import { MAX_CENTS } from '@/modules/accounting/services/budgets/grid/cents';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';

const FY = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
const ALL = { fromMonth: FY[0] as string, toMonth: FY[11] as string };

function row(acct: string, band: Band, cc1Id: string | null = null): DriverRow {
  const ref = { glAccountId: acct, cc1Id, cc2Id: null, buId: null };
  return { key: rowKeyFor(ref), ...ref, band };
}
const SALES = row('sales', 'turnover');
const COGS = row('cogs', 'cost_of_sales');
const RENT = row('rent', 'operating_expense');
const SALARIES = row('salaries', 'operating_expense');

const flat = (amount: number, months = FY, source: CellSource = 'manual'): Cell[] =>
  months.map(month => ({ month, amount, source }));

function run(over: Partial<ComputeInput> & Pick<ComputeInput, 'drivers'>) {
  return computeVersion({
    months: FY, rows: [SALES, COGS, RENT, SALARIES], cells: new Map(), headcount: () => 0,
    closedMonths: new Set(), rounding: 1, ...over,
  });
}
const amountsOf = (writes: { rowKey: RowKey; amount: number }[], key: RowKey) =>
  writes.filter(w => w.rowKey === key).map(w => w.amount);

describe('arithmetic per kind', () => {
  it('fixed: R x per month, rounded to the unit', () => {
    const { writes } = run({ drivers: [{ kind: 'fixed', rowKey: RENT.key, amount: 1500050, ...ALL }] });
    expect(amountsOf(writes, RENT.key)).toEqual(FY.map(() => 1500100));
    expect(writes.every(w => w.source === 'driver')).toBe(true);
  });

  it('pct_of_line: 38% of Sales, rounded once (half away from zero) to the unit', () => {
    const cells = new Map([[SALES.key, flat(123457)]]);
    const d: DriverDef = { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 38, ...ALL };
    expect(amountsOf(run({ cells, drivers: [d] }).writes, COGS.key)[0]).toBe(46900);
    expect(amountsOf(run({ cells, drivers: [d], rounding: 100 }).writes, COGS.key)[0]).toBe(50000);
    expect(amountsOf(run({ cells, drivers: [d], rounding: 1000 }).writes, COGS.key)[0]).toBe(0);
    const neg = new Map([[SALES.key, flat(-123457)]]);
    expect(amountsOf(run({ cells: neg, drivers: [d] }).writes, COGS.key)[0]).toBe(-46900);
  });

  it("a driver's own rounding unit wins over the caller's (decision 5, stored per driver)", () => {
    const cells = new Map([[SALES.key, flat(123457)]]);
    const d: DriverDef = { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 38, rounding: 100, ...ALL };
    expect(amountsOf(run({ cells, drivers: [d], rounding: 1 }).writes, COGS.key)[0]).toBe(50000);
    expect(amountsOf(run({ cells, drivers: [{ ...d, rounding: undefined }], rounding: 1 }).writes, COGS.key)[0]).toBe(46900);
  });

  it('pct_of_line: 4-dp percent is exact', () => {
    const cells = new Map([[SALES.key, flat(100000000)]]);
    const d: DriverDef = { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 12.3456, ...ALL };
    expect(amountsOf(run({ cells, drivers: [d] }).writes, COGS.key)[0]).toBe(12345600);
  });

  it('pct_of_section: company scope sums the band over every grain; same_grain only its own', () => {
    const salesA = row('sales', 'turnover', 'A');
    const rentA = row('rent', 'operating_expense', 'A');
    const rows = [SALES, salesA, COGS, RENT, rentA];
    const cells = new Map([[SALES.key, flat(1000000)], [salesA.key, flat(500000)]]);
    const drivers: DriverDef[] = [
      { kind: 'pct_of_section', rowKey: RENT.key, section: 'turnover', scope: 'company', pct: 10, ...ALL },
      { kind: 'pct_of_section', rowKey: rentA.key, section: 'turnover', scope: 'same_grain', pct: 10, ...ALL },
    ];
    const { writes } = run({ rows, cells, drivers });
    expect(amountsOf(writes, RENT.key)[0]).toBe(150000);
    expect(amountsOf(writes, rentA.key)[0]).toBe(50000);
  });

  it('growth compounds m/m: base × (1+g)^k, k = months since base', () => {
    const cells = new Map([[SALES.key, [{ month: '2026-03', amount: 100000, source: 'manual' as const }]]]);
    const d: DriverDef = { kind: 'growth', rowKey: SALES.key, pct: 10, baseMonth: '2026-03', fromMonth: '2026-04', toMonth: '2026-07' };
    expect(amountsOf(run({ cells, drivers: [d] }).writes, SALES.key)).toEqual([110000, 121000, 133100, 146400]);
  });

  it('per_head: R x per head × FTE headcount for the scope and month', () => {
    const calls: [string | null, string][] = [];
    const headcount = (scope: string | null, month: string) => { calls.push([scope, month]); return month === '2026-03' ? 2.5 : 3; };
    const d: DriverDef = { kind: 'per_head', rowKey: SALARIES.key, amount: 3200000, headcountScope: 'CC-A', fromMonth: '2026-03', toMonth: '2026-04' };
    expect(amountsOf(run({ drivers: [d], headcount }).writes, SALARIES.key)).toEqual([8000000, 9600000]);
    expect(calls).toEqual([['CC-A', '2026-03'], ['CC-A', '2026-04']]);
  });

  it('a downstream row reads the EFFECTIVE value of its ref (driver output, override kept)', () => {
    const cells = new Map([[SALES.key, [{ month: '2026-03', amount: 100000, source: 'manual' as const },
      { month: '2026-05', amount: 999900, source: 'override' as const }]]]);
    const drivers: DriverDef[] = [
      { kind: 'growth', rowKey: SALES.key, pct: 10, baseMonth: '2026-03', fromMonth: '2026-04', toMonth: '2026-05' },
      { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 50, fromMonth: '2026-03', toMonth: '2026-05' },
    ];
    expect(amountsOf(run({ cells, drivers }).writes, COGS.key)).toEqual([50000, 55000, 500000]);
  });
});

describe('cells a driver must never write', () => {
  it('override and actual cells stay as they are', () => {
    const cells = new Map([[RENT.key, [{ month: '2026-04', amount: 777700, source: 'override' as const },
      { month: '2026-05', amount: 123400, source: 'actual' as const }]]]);
    const { writes } = run({ cells, drivers: [{ kind: 'fixed', rowKey: RENT.key, amount: 100000, ...ALL }] });
    expect(writes.map(w => w.month)).not.toContain('2026-04');
    expect(writes.map(w => w.month)).not.toContain('2026-05');
    expect(writes).toHaveLength(10);
  });

  it('closed months are never written', () => {
    const { writes } = run({ closedMonths: new Set(['2026-03', '2026-04']), drivers: [{ kind: 'fixed', rowKey: RENT.key, amount: 100000, ...ALL }] });
    expect(writes.map(w => w.month)).toEqual(FY.slice(2));
  });

  it('months outside [from, to] stay manual', () => {
    const cells = new Map([[RENT.key, flat(5000)]]);
    const { writes } = run({ cells, drivers: [{ kind: 'fixed', rowKey: RENT.key, amount: 100000, fromMonth: '2026-06', toMonth: '2026-08' }] });
    expect(writes.map(w => w.month)).toEqual(['2026-06', '2026-07', '2026-08']);
  });
});

describe('warnings, idempotence, order', () => {
  it('a ref row with no cell in a month reads 0 and warns once for that ref', () => {
    const cells = new Map([[SALES.key, flat(100000, ['2026-03'])]]);
    const d: DriverDef = { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 50, fromMonth: '2026-03', toMonth: '2026-05' };
    const { writes, warnings } = run({ cells, drivers: [d] });
    expect(amountsOf(writes, COGS.key)).toEqual([50000, 0, 0]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'REF_MISSING', rowKey: COGS.key });
    expect(warnings[0]?.message).toContain(SALES.key);
  });

  it('an unchanged recompute writes nothing; a manual cell already equal to the value is re-sourced', () => {
    const drivers: DriverDef[] = [{ kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 50, ...ALL }];
    const cells = new Map<RowKey, Cell[]>([[SALES.key, flat(100000)], [COGS.key, flat(50000, FY, 'driver')]]);
    expect(run({ cells, drivers }).writes).toEqual([]);
    const manual = new Map<RowKey, Cell[]>([[SALES.key, flat(100000)], [COGS.key, flat(50000)]]);
    expect(run({ cells: manual, drivers }).writes).toHaveLength(12);
  });

  it('output order is topo order, then month order', () => {
    const drivers: DriverDef[] = [
      { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 50, fromMonth: '2026-03', toMonth: '2026-04' },
      { kind: 'fixed', rowKey: SALES.key, amount: 100000, fromMonth: '2026-03', toMonth: '2026-04' },
    ];
    const { writes } = run({ drivers });
    expect(writes.map(w => `${w.rowKey}@${w.month}`)).toEqual(
      ['sales|||@2026-03', 'sales|||@2026-04', 'cogs|||@2026-03', 'cogs|||@2026-04']);
  });

  it('a 14-month transition year: every month computed, k counts list positions', () => {
    const months = [...FY, '2027-03', '2027-04'];
    const cells = new Map([[SALES.key, [{ month: months[0] as string, amount: 100000, source: 'manual' as const }]]]);
    const d: DriverDef = { kind: 'growth', rowKey: SALES.key, pct: 10, baseMonth: '2026-03', fromMonth: '2026-04', toMonth: '2027-04' };
    const { writes } = run({ months, cells, drivers: [d] });
    expect(amountsOf(writes, SALES.key)).toEqual([110000, 121000, 133100, 146400, 161100, 177200, 194900,
      214400, 235800, 259400, 285300, 313800, 345200]);
  });
});

describe('refusals', () => {
  it('a result beyond NUMERIC(15,2) throws DriverRangeError', () => {
    const cells = new Map([[SALES.key, flat(MAX_CENTS - 99)]]);
    const d: DriverDef = { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 200, ...ALL };
    expect(() => run({ cells, drivers: [d] })).toThrow(DriverRangeError);
  });

  it('a bad month range or growth base throws DriverRefError', () => {
    const bad: DriverDef[] = [
      { kind: 'fixed', rowKey: RENT.key, amount: 1, fromMonth: '2026-05', toMonth: '2026-04' },
      { kind: 'fixed', rowKey: RENT.key, amount: 1, fromMonth: '2026-02', toMonth: '2026-04' },
      { kind: 'fixed', rowKey: RENT.key, amount: 1, fromMonth: '2026-03', toMonth: '2027-03' },
      { kind: 'growth', rowKey: RENT.key, pct: 1, baseMonth: '2026-04', fromMonth: '2026-04', toMonth: '2026-06' },
      { kind: 'growth', rowKey: RENT.key, pct: 1, baseMonth: '2026-02', fromMonth: '2026-04', toMonth: '2026-06' },
      { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 1.23456, ...ALL },
    ];
    for (const d of bad) expect(() => run({ drivers: [d] }), JSON.stringify(d)).toThrow(DriverRefError);
  });

  it('a cycle throws DriverCycleError in compute too (defence in depth)', () => {
    const drivers: DriverDef[] = [
      { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 50, ...ALL },
      { kind: 'pct_of_line', rowKey: SALES.key, refRowKey: COGS.key, pct: 50, ...ALL },
    ];
    expect(() => run({ drivers })).toThrow(DriverCycleError);
  });
});
