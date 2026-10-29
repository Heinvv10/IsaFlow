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
import { cellWriteRefusal } from '@/modules/accounting/services/budgets/drivers/reforecastInputs';
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

  it("a failed roll records a typed refusal's message, or a fixed text for anything else, and never throws", async () => {
    m.fyForDate.mockResolvedValue({ fiscalYear: 2027 });
    m.roll.mockRejectedValueOnce(Object.assign(new Error('insert on table "x" violates key (company_id)=(c1)'), { code: '23505' }));
    await expect(runBudgetRolls(P, ['2026-03-31'])).resolves.toBeUndefined();
    m.roll.mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_STATE', 'The forecast could not be written'));
    await expect(runBudgetRolls(P, ['2026-03-31'])).resolves.toBeUndefined();
    expect(recorded()).toEqual(['the roll failed; see the server log', 'The forecast could not be written']);
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
