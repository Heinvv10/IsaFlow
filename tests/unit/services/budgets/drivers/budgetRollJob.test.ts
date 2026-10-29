/**
 * The after-commit roll job never throws (Budgets P4 spec §6, PR-4 breaker round 1): an end date
 * whose fiscal year cannot be found is logged with the company and the date and the others still
 * roll; a failed roll records a last_error that is a typed refusal's message or a fixed text, never
 * database text (it names ids); a job that cannot even connect is logged. And a cell write's
 * database refusal reaches a caller typed, never as raw text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(), fyForDate: vi.fn(), roll: vi.fn(), connect: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql, getPool: () => ({ connect: m.connect }), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: m.fyForDate, getFiscalYear: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/rollingForecastService', () => ({ rollVersion: m.roll }));

import { log } from '@/lib/logger';
import { runBudgetRolls } from '@/modules/accounting/services/budgets/drivers/budgetRollJob';
import { ForecastCellRefusal, cellWriteRefusal, describeUnplaced } from '@/modules/accounting/services/budgets/drivers/reforecastInputs';
import { BudgetDriverError } from '@/modules/accounting/services/budgets/drivers/driverErrors';
import { DriverRangeError } from '@/modules/accounting/services/budgets/drivers/driverTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';

const P = { userId: 'u1', companyId: 'c1', claims: { sub: 'u1' } };
const client = () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() });
/** The last_error each failed-roll UPDATE recorded. */
const recorded = () => m.sql.mock.calls
  .filter((c) => String((c[0] as TemplateStringsArray).join('?')).includes('SET last_error'))
  .map((c) => c[1] as string);

beforeEach(() => {
  vi.clearAllMocks();
  m.connect.mockImplementation(async () => client());
  m.sql.mockImplementation(async (strings: TemplateStringsArray) =>
    (strings.join('?').includes('FROM budget_rolling_forecasts') ? [{ id: 'v1', fiscal_year: 2027 }, { id: 'v2', fiscal_year: 2028 }] : []));
  m.roll.mockResolvedValue({ status: 'rolled', changed: 1, rolledThroughMonth: '2026-03' });
});

describe('runBudgetRolls', () => {
  it('an end date whose fiscal year cannot be found is logged with the company and date; the others still roll', async () => {
    m.fyForDate.mockImplementation(async (_c: string, d: string) => {
      if (d === '2026-03-31') return { fiscalYear: 2027 };
      throw new Error('fiscalYearForDate: no fiscal year');
    });
    await expect(runBudgetRolls(P, ['1999-01-31', '2026-03-31'])).resolves.toBeUndefined();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringMatching(/no fiscal year/), expect.objectContaining({ companyId: 'c1', endDate: '1999-01-31' }), 'accounting');
    expect(m.roll).toHaveBeenCalledTimes(1);
    expect(m.roll).toHaveBeenCalledWith('c1', 'u1', 'v1', 'auto');
  });

  it('a failed roll records a fixed phrase per error class, never exception text, and never throws', async () => {
    m.fyForDate.mockResolvedValue({ fiscalYear: 2027 });
    for (const err of [
      Object.assign(new Error('insert on table "x" violates key (company_id)=(c1)'), { code: '23505' }),
      new BudgetVersionError('BUDGET_VERSION_STATE', 'some state of company c1'),
      new BudgetDriverError('DRIVER_RANGE', 'A budget driver cannot compute: 6100 Rent beyond range'),
      new DriverRangeError('Actuals of 6100 in 2026-03 exceed the budget range', 'a', '2026-03'),
      new ForecastCellRefusal(),
    ]) {
      m.roll.mockRejectedValueOnce(err);
      await expect(runBudgetRolls(P, ['2026-03-31'])).resolves.toBeUndefined();
    }
    expect(recorded()).toEqual([
      'roll failed; see logs', 'roll failed; see logs', 'a driver result is beyond the budget range',
      'a driver result is beyond the budget range', 'invalid dimension on actuals',
    ]);
  });

  it('a job that cannot even take a connection is logged, not thrown', async () => {
    m.connect.mockRejectedValue(new Error('pool exhausted'));
    await expect(runBudgetRolls(P, ['2026-03-31'])).resolves.toBeUndefined();
    expect(m.roll).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalled();
  });
});

describe('cellWriteRefusal', () => {
  it('a check or reference refusal is a typed 409 without database text; locked and grain map as P1 maps them', () => {
    const raw = Object.assign(new Error('budget cc1_id abc is not a CC1 cost centre of company c1'), { code: '23514' });
    const typed = cellWriteRefusal('c1', 'v1', raw);
    expect(typed).toBeInstanceOf(BudgetVersionError);
    expect(typed).toMatchObject({ code: 'BUDGET_VERSION_STATE', status: 409 });
    expect((typed as Error).message).not.toMatch(/c1|abc/);
    expect(cellWriteRefusal('c1', 'v1', Object.assign(new Error('fk'), { code: '23503' }))).toMatchObject({ code: 'BUDGET_VERSION_STATE' });
    expect(cellWriteRefusal('c1', 'v1', Object.assign(new Error('locked'), { code: 'BV001' }))).toMatchObject({ code: 'BUDGET_VERSION_LOCKED' });
    const other = new Error('boom');
    expect(cellWriteRefusal('c1', 'v1', other)).toBe(other);
  });
});

describe('describeUnplaced', () => {
  it('names the grain the account is budgeted at, and company (never CC1) for an account with no row', () => {
    const plan = {
      rows: [{ key: 'a1|c|| ', glAccountId: 'a1', cc1Id: null, cc2Id: null, buId: 'b1', band: 'operating_expense' as const }],
      cells: new Map(), warnings: [],
      unplaced: [{ accountId: 'a1', month: '2026-03', amount: 12345 }, { accountId: 'a2', month: '2026-03', amount: -100 }],
    };
    const read = { actuals: { company: [], cc1: [], cc2: [], bu: [] }, accounts: new Map([
      ['a1', { accountId: 'a1', accountCode: '6100', accountName: 'Rent', accountType: 'expense' as const, accountSubtype: null }],
    ]) };
    expect(describeUnplaced(plan, read).map((u) => [u.accountCode, u.level, u.amount])).toEqual([['6100', 'bu', 123.45], ['', 'company', -1]]);
  });
});
