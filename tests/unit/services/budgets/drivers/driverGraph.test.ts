/**
 * Driver dependency graph (P4 spec §4, §9): edges run driven row ← referenced
 * row; a section ref is an edge from every row of that band at the scope; Kahn
 * order is deterministic; every cycle (self, 2-node, 3-node via a section) is
 * refused with the path of row keys, first == last.
 */
import { describe, it, expect } from 'vitest';
import { buildDriverGraph, topoOrder, assertNoCycle } from '@/modules/accounting/services/budgets/drivers/driverGraph';
import {
  DriverCycleError, DriverRefError, rowKeyFor, type DriverDef, type DriverRow,
} from '@/modules/accounting/services/budgets/drivers/driverTypes';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';

function row(acct: string, band: Band, dims: Partial<Pick<DriverRow, 'cc1Id' | 'cc2Id' | 'buId'>> = {}): DriverRow {
  const ref = { glAccountId: acct, cc1Id: dims.cc1Id ?? null, cc2Id: dims.cc2Id ?? null, buId: dims.buId ?? null };
  return { key: rowKeyFor(ref), ...ref, band };
}

const SALES = row('sales', 'turnover');
const COGS = row('cogs', 'cost_of_sales');
const RENT = row('rent', 'operating_expense');
const FEES = row('fees', 'other_income');
const RANGE = { fromMonth: '2026-03', toMonth: '2027-02' };

const line = (driven: DriverRow, ref: DriverRow, pct = 38): DriverDef =>
  ({ kind: 'pct_of_line', rowKey: driven.key, refRowKey: ref.key, pct, ...RANGE });
const section = (driven: DriverRow, band: Band, scope: 'same_grain' | 'company'): DriverDef =>
  ({ kind: 'pct_of_section', rowKey: driven.key, section: band, scope, pct: 5, ...RANGE });

function cycleOf(fn: () => unknown): DriverCycleError {
  try { fn(); } catch (e) {
    if (e instanceof DriverCycleError) return e;
    throw e;
  }
  throw new Error('expected a DriverCycleError, none thrown');
}

describe('rowKeyFor', () => {
  it('is the grid rowKeyOf shape: acct|cc1|cc2|bu', () => {
    expect(SALES.key).toBe('sales|||');
    expect(rowKeyFor({ glAccountId: 'a', cc1Id: null, cc2Id: 'x', buId: null })).toBe('a||x|');
  });
});

describe('buildDriverGraph', () => {
  it('pct_of_line: one edge from the referenced row', () => {
    const g = buildDriverGraph([SALES, COGS], [line(COGS, SALES)]);
    expect([...(g.refs.get(COGS.key) ?? [])]).toEqual([SALES.key]);
    expect(g.refs.get(SALES.key)?.size ?? 0).toBe(0);
  });

  it('pct_of_section company: an edge from every row of the band, any grain', () => {
    const cogsA = row('cogs', 'cost_of_sales', { cc1Id: 'A' });
    const freight = row('freight', 'cost_of_sales', { buId: 'B' });
    const g = buildDriverGraph([SALES, COGS, cogsA, freight, RENT], [section(RENT, 'cost_of_sales', 'company')]);
    expect([...(g.refs.get(RENT.key) ?? [])].sort()).toEqual([cogsA.key, COGS.key, freight.key].sort());
  });

  it('pct_of_section same_grain: only rows of the band at the driven row grain', () => {
    const rentA = row('rent', 'operating_expense', { cc1Id: 'A' });
    const salesA = row('sales', 'turnover', { cc1Id: 'A' });
    const salesB = row('sales', 'turnover', { cc1Id: 'B' });
    const travelA = row('travel', 'turnover', { cc1Id: 'A' });
    const g = buildDriverGraph([SALES, salesA, salesB, travelA, rentA], [section(rentA, 'turnover', 'same_grain')]);
    expect([...(g.refs.get(rentA.key) ?? [])].sort()).toEqual([salesA.key, travelA.key].sort());
  });

  it('growth, fixed and per_head add no edges', () => {
    const drivers: DriverDef[] = [
      { kind: 'growth', rowKey: SALES.key, pct: 2, baseMonth: '2026-03', fromMonth: '2026-04', toMonth: '2027-02' },
      { kind: 'fixed', rowKey: RENT.key, amount: 1500000, ...RANGE },
      { kind: 'per_head', rowKey: COGS.key, amount: 3200000, headcountScope: null, ...RANGE },
    ];
    const g = buildDriverGraph([SALES, COGS, RENT], drivers);
    for (const r of [SALES, COGS, RENT]) expect(g.refs.get(r.key)?.size ?? 0).toBe(0);
  });

  it('refuses a driver on an unknown row, an unknown ref, two drivers on one row, a multi-dimension row', () => {
    expect(() => buildDriverGraph([SALES], [line(COGS, SALES)])).toThrow(DriverRefError);
    expect(() => buildDriverGraph([COGS], [line(COGS, SALES)])).toThrow(DriverRefError);
    expect(() => buildDriverGraph([SALES, COGS], [line(COGS, SALES), line(COGS, SALES, 10)])).toThrow(DriverRefError);
    expect(() => buildDriverGraph([row('x', 'turnover', { cc1Id: 'A', buId: 'B' })], [])).toThrow(DriverRefError);
    expect(() => buildDriverGraph([SALES, SALES], [])).toThrow(DriverRefError);
    expect(() => buildDriverGraph([{ ...SALES, key: 'wrong' }], [])).toThrow(DriverRefError);
  });
});

describe('topoOrder', () => {
  it('puts every referenced row before the row it drives, ties broken by key', () => {
    const drivers = [line(COGS, SALES), section(RENT, 'cost_of_sales', 'company'), line(FEES, RENT, 1)];
    const order = topoOrder(buildDriverGraph([RENT, FEES, COGS, SALES], drivers));
    expect(order).toEqual([SALES.key, COGS.key, RENT.key, FEES.key]);
  });

  it('is independent of input order', () => {
    const drivers = [line(COGS, SALES)];
    const a = topoOrder(buildDriverGraph([SALES, COGS, RENT, FEES], drivers));
    const b = topoOrder(buildDriverGraph([FEES, RENT, COGS, SALES], [...drivers].reverse()));
    expect(a).toEqual(b);
    expect(a).toEqual(['fees|||', 'rent|||', 'sales|||', 'cogs|||']);
  });
});

describe('cycles are refused with the path', () => {
  it('self via pct_of_line', () => {
    const e = cycleOf(() => topoOrder(buildDriverGraph([SALES], [line(SALES, SALES)])));
    expect(e.path).toEqual([SALES.key, SALES.key]);
  });

  it('self via own section (a row inside the section it is a % of)', () => {
    const e = cycleOf(() => topoOrder(buildDriverGraph([SALES, COGS], [section(COGS, 'cost_of_sales', 'company')])));
    expect(e.path).toEqual([COGS.key, COGS.key]);
  });

  it('2-node: Sales → COGS → Sales', () => {
    const e = cycleOf(() => topoOrder(buildDriverGraph([SALES, COGS, RENT], [line(COGS, SALES), line(SALES, COGS)])));
    expect(e.path).toEqual([COGS.key, SALES.key, COGS.key]);
    expect(e.message).toContain('cogs||| → sales||| → cogs|||');
  });

  it('3-node via a section: COGS → Rent (opex = % of cost of sales) → Sales → COGS', () => {
    const drivers = [line(COGS, SALES), section(RENT, 'cost_of_sales', 'company'), line(SALES, RENT, 400)];
    const e = cycleOf(() => topoOrder(buildDriverGraph([SALES, COGS, RENT, FEES], drivers)));
    expect(e.path).toEqual([COGS.key, RENT.key, SALES.key, COGS.key]);
  });

  it('assertNoCycle: the save-time validator throws on a cycle and passes a DAG', () => {
    expect(() => assertNoCycle([SALES, COGS], [line(COGS, SALES)])).not.toThrow();
    const e = cycleOf(() => assertNoCycle([SALES, COGS], [line(COGS, SALES), line(SALES, COGS)]));
    expect(e.path[0]).toBe(e.path[e.path.length - 1]);
  });
});
