/**
 * planReforecast (P4 spec §1.3, §4, §5): closed months = actuals at each
 * row's grain (source 'actual', 0 when none), open months = the source cell
 * with its source, drivers then recompute so an open-month growth / % driver
 * feeds off closed-month actuals. Untagged actuals on a dimension-grain
 * account are reported as unplaced, never dropped, never put on a company row.
 */
import { describe, it, expect } from 'vitest';
import {
  planReforecast, type ReforecastActual, type ReforecastInput,
} from '@/modules/accounting/services/budgets/drivers/reforecast';
import {
  rowKeyFor, type Cell, type DriverDef, type DriverRow, type RowKey,
} from '@/modules/accounting/services/budgets/drivers/driverTypes';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';

const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
const CLOSED = new Set(['2026-03', '2026-04']);

function row(acct: string, band: Band, cc1Id: string | null = null): DriverRow {
  const ref = { glAccountId: acct, cc1Id, cc2Id: null, buId: null };
  return { key: rowKeyFor(ref), ...ref, band };
}
const SALES = row('sales', 'turnover');
const COGS = row('cogs', 'cost_of_sales');
const RENT_A = row('rent', 'operating_expense', 'A');
const RENT_B = row('rent', 'operating_expense', 'B');

const flat = (amount: number, source: Cell['source'] = 'manual'): Cell[] => MONTHS.map(month => ({ month, amount, source }));
const act = (accountId: string, month: string, amount: number, memberId: string | null = null): ReforecastActual =>
  ({ accountId, month, amount, memberId });
const BANDS: Record<string, Band> = { sales: 'turnover', cogs: 'cost_of_sales', rent: 'operating_expense', fuel: 'operating_expense' };

function plan(over: Partial<ReforecastInput> = {}) {
  return planReforecast({
    months: MONTHS,
    rows: [SALES, COGS, RENT_A, RENT_B],
    sourceCells: new Map<RowKey, Cell[]>([[SALES.key, flat(100000)], [COGS.key, flat(40000)],
      [RENT_A.key, flat(30000)], [RENT_B.key, flat(20000, 'override')]]),
    actuals: { company: [], cc1: [], cc2: [], bu: [] },
    closedMonths: CLOSED,
    drivers: [],
    headcount: () => 0,
    rounding: 1,
    accountBand: (id: string) => BANDS[id] ?? 'operating_expense',
    ...over,
  });
}
const view = (cells: Cell[] | undefined) => (cells ?? []).map(c => `${c.month}:${c.amount}:${c.source}`);

describe('closed months take actuals, open months the source', () => {
  it('company grain: actual (0 when none) in closed months, source cell kept in open months', () => {
    const actuals = { company: [act('sales', '2026-03', 250000), act('sales', '2026-06', 1)], cc1: [], cc2: [], bu: [] };
    // RENT_B's override sits inside a driver's range: the driver never writes over it.
    const drivers: DriverDef[] = [{ kind: 'fixed', rowKey: RENT_B.key, amount: 1, fromMonth: '2026-03', toMonth: '2026-07' }];
    const out = plan({ actuals, drivers });
    expect(view(out.cells.get(SALES.key))).toEqual([
      '2026-03:250000:actual', '2026-04:0:actual', '2026-05:100000:manual', '2026-06:100000:manual', '2026-07:100000:manual']);
    expect(view(out.cells.get(RENT_B.key)).slice(2)).toEqual(['2026-05:20000:override', '2026-06:20000:override', '2026-07:20000:override']);
  });

  it('dimension grain: each member\'s actual lands on its own row; company list is not read for that account', () => {
    const actuals = {
      company: [act('rent', '2026-03', 999999)],
      cc1: [act('rent', '2026-03', 31000, 'A'), act('rent', '2026-03', 22000, 'B'), act('rent', '2026-04', 1000, 'A'), act('rent', '2026-04', 500, 'A')],
      cc2: [], bu: [],
    };
    const out = plan({ actuals });
    expect(view(out.cells.get(RENT_A.key)).slice(0, 2)).toEqual(['2026-03:31000:actual', '2026-04:1500:actual']);
    expect(view(out.cells.get(RENT_B.key)).slice(0, 2)).toEqual(['2026-03:22000:actual', '2026-04:0:actual']);
    expect(out.cells.has('rent|||')).toBe(false);
  });

  it('an actual for a member with no source row creates that row, closed months only', () => {
    const actuals = { company: [], cc1: [act('rent', '2026-04', 7000, 'C')], cc2: [], bu: [] };
    const out = plan({ actuals });
    expect(view(out.cells.get('rent|C||'))).toEqual(['2026-03:0:actual', '2026-04:7000:actual']);
    expect(out.rows.find(r => r.key === 'rent|C||')).toMatchObject({ glAccountId: 'rent', cc1Id: 'C', band: 'operating_expense' });
  });

  it('an unbudgeted account gets a company row from the company actuals', () => {
    const actuals = { company: [act('fuel', '2026-03', 4200)], cc1: [act('fuel', '2026-03', 4200, 'A')], cc2: [], bu: [] };
    const out = plan({ actuals });
    expect(view(out.cells.get('fuel|||'))).toEqual(['2026-03:4200:actual', '2026-04:0:actual']);
    expect(out.cells.has('fuel|A||')).toBe(false);
  });
});

describe('unplaced untagged actuals', () => {
  it('a NULL member on a dimension-grain account is reported, summed per account + month', () => {
    const actuals = {
      company: [],
      cc1: [act('rent', '2026-03', 500), act('rent', '2026-03', 250), act('rent', '2026-04', 100), act('rent', '2026-06', 9)],
      cc2: [], bu: [],
    };
    const out = plan({ actuals });
    expect(out.unplaced).toEqual([
      { accountId: 'rent', month: '2026-03', amount: 750 },
      { accountId: 'rent', month: '2026-04', amount: 100 },
    ]);
    expect(out.cells.has('rent|||')).toBe(false);
    expect(out.cells.get(RENT_A.key)?.[0]?.amount).toBe(0);
  });
});

describe('a month reopened after a roll', () => {
  it('its stale actual becomes manual (value kept) on a plain row, and is recomputed on a driver row', () => {
    const drivers: DriverDef[] = [
      { kind: 'growth', rowKey: SALES.key, pct: 10, baseMonth: '2026-03', fromMonth: '2026-04', toMonth: '2026-07' },
    ];
    const actuals = { company: [act('sales', '2026-03', 200000), act('sales', '2026-04', 500000)],
      cc1: [act('rent', '2026-04', 33000, 'A')], cc2: [], bu: [] };
    const roll1 = plan({ drivers, actuals });
    expect(view(roll1.cells.get(SALES.key)).slice(0, 2)).toEqual(['2026-03:200000:actual', '2026-04:500000:actual']);
    const roll2 = plan({ drivers, actuals, rows: roll1.rows, sourceCells: roll1.cells, closedMonths: new Set(['2026-03']) });
    expect(view(roll2.cells.get(RENT_A.key)).slice(0, 2)).toEqual(['2026-03:0:actual', '2026-04:33000:manual']);
    expect(view(roll2.cells.get(SALES.key)).slice(0, 3)).toEqual(['2026-03:200000:actual', '2026-04:220000:driver', '2026-05:242000:driver']);
  });
});

describe('unplaced zero net', () => {
  it('untagged actuals that net to zero in a month are not reported; non-zero nets are', () => {
    const actuals = { company: [], cc1: [act('rent', '2026-03', 500), act('rent', '2026-03', -500), act('rent', '2026-04', -80)], cc2: [], bu: [] };
    expect(plan({ actuals }).unplaced).toEqual([{ accountId: 'rent', month: '2026-04', amount: -80 }]);
  });
});

describe('drivers recompute off closed-month actuals', () => {
  it('growth in an open month compounds from a closed-month actual base; % rows follow', () => {
    const drivers: DriverDef[] = [
      { kind: 'growth', rowKey: SALES.key, pct: 10, baseMonth: '2026-04', fromMonth: '2026-05', toMonth: '2026-07' },
      { kind: 'pct_of_line', rowKey: COGS.key, refRowKey: SALES.key, pct: 40, fromMonth: '2026-03', toMonth: '2026-07' },
    ];
    const actuals = { company: [act('sales', '2026-04', 200000), act('cogs', '2026-04', 90000)], cc1: [], cc2: [], bu: [] };
    const out = plan({ drivers, actuals });
    expect(view(out.cells.get(SALES.key))).toEqual([
      '2026-03:0:actual', '2026-04:200000:actual', '2026-05:220000:driver', '2026-06:242000:driver', '2026-07:266200:driver']);
    expect(view(out.cells.get(COGS.key))).toEqual([
      '2026-03:0:actual', '2026-04:90000:actual', '2026-05:88000:driver', '2026-06:96800:driver', '2026-07:106500:driver']);
  });

  it('re-rolling its own output changes nothing (idempotent)', () => {
    const drivers: DriverDef[] = [{ kind: 'growth', rowKey: SALES.key, pct: 10, baseMonth: '2026-04', fromMonth: '2026-05', toMonth: '2026-07' }];
    const actuals = { company: [act('sales', '2026-04', 200000)], cc1: [act('rent', '2026-03', 5, 'C')], cc2: [], bu: [] };
    const first = plan({ drivers, actuals });
    const second = plan({ drivers, actuals, rows: first.rows, sourceCells: first.cells });
    expect([...second.cells.entries()]).toEqual([...first.cells.entries()]);
  });

  it('refuses an account whose source rows mix grains (decision 4)', () => {
    expect(() => plan({ rows: [SALES, COGS, RENT_A, row('rent', 'operating_expense')] })).toThrow(/grain/);
  });
});
