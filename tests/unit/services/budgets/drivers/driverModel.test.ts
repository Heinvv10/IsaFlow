/**
 * loadVersionModel: a row a driver only reads, at a grain its account is not budgeted at, is not a
 * row (it would put the account at two grains, which a reforecast cannot plan); its reader is skipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));

import { loadVersionModel } from '@/modules/accounting/services/budgets/drivers/driverModel';
import { rowKeyOfGrain, type DriverGrain, type DriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import { unplacedActuals } from '@/modules/accounting/services/budgets/drivers/reforecast';

const SALES = '11111111-1111-4111-8111-111111111111';
const COGS = '22222222-2222-4222-8222-222222222222';
const CC1 = '33333333-3333-4333-8333-333333333333';
const MONTHS = ['2026-03', '2026-04'];

const grain = (glAccountId: string, cc1Id: string | null = null): DriverGrain => ({ glAccountId, cc1Id, cc2Id: null, buId: null });
const cogsReading = (ref: DriverGrain): DriverLine => ({
  ...grain(COGS), kind: 'pct_of_line', fromMonth: '2026-03', toMonth: '2026-04', amount: null, pct: 40, ref,
  section: null, scope: null, baseMonth: null, headcountCostCentreId: null, rounding: 1,
} as DriverLine);
const accounts = [
  { id: SALES, account_code: '4000', account_name: 'Sales', account_type: 'revenue', account_subtype: null },
  { id: COGS, account_code: '5100', account_name: 'Cost of sales', account_type: 'expense', account_subtype: 'cost_of_sales' },
];

function db(cells: Array<{ a: string; c1: string | null }>) {
  m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    if (strings.join('').includes('budget_month_amounts')) {
      return cells.map((c) => ({ ...c, c2: null, b: null, m: '2026-03', amount: '100.00', amount_source: 'manual' }));
    }
    return accounts;
  });
}

const noActuals = { company: [], cc1: [], cc2: [], bu: [] };

describe('loadVersionModel: a read at another grain', () => {
  beforeEach(() => { m.sql.mockReset(); });

  it('Sales budgeted at CC1, a driver reading company Sales: no company Sales row, the driver is skipped', async () => {
    db([{ a: SALES, c1: CC1 }]);
    const model = await loadVersionModel('co', 'v', MONTHS, [cogsReading(grain(SALES))]);
    const keys = model.rows.map((r) => r.key);
    expect(keys).toContain(rowKeyOfGrain(grain(SALES, CC1)));
    expect(keys).not.toContain(rowKeyOfGrain(grain(SALES)));
    expect(model.defs).toEqual([]);
    expect(model.skipped).toEqual([{
      rowKey: rowKeyOfGrain(grain(COGS)),
      message: expect.stringMatching(/^driver on 5100 Cost of sales cannot compute: the account it reads \(4000 Sales\) is budgeted at another level/),
    }]);
    // The reforecast's grain rule reads these rows without "budgeted at two grains".
    expect(() => unplacedActuals({ months: MONTHS, rows: model.rows, actuals: noActuals, closedMonths: new Set() })).not.toThrow();
  });

  it('a read at the grain the account is budgeted at stays a row and computes', async () => {
    db([{ a: SALES, c1: CC1 }]);
    const model = await loadVersionModel('co', 'v', MONTHS, [cogsReading(grain(SALES, CC1))]);
    expect(model.skipped).toEqual([]);
    expect(model.defs).toHaveLength(1);
  });

  it('a read of an account holding no cells still makes its row (reads 0)', async () => {
    db([]);
    const model = await loadVersionModel('co', 'v', MONTHS, [cogsReading(grain(SALES))]);
    expect(model.rows.map((r) => r.key)).toContain(rowKeyOfGrain(grain(SALES)));
    expect(model.skipped).toEqual([]);
  });
});
