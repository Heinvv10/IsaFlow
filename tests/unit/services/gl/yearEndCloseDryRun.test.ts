/**
 * `year_end_close` — the dry run is the important half.
 *
 * Brightsphere has four unclosed year-ends and R8.46m of "retained earnings"
 * with no journal lines behind it, so equity is a computed residual and the
 * balance sheet balancing proves nothing. The remedy is a posting that moves
 * four years of P&L into equity in one call, which is exactly the kind of call
 * nobody should make without seeing it first.
 *
 * So the dry run must show: which periods block the close (named, not counted),
 * and the retained-earnings journal that would post — every line, both totals.
 *
 * Two defects are fixed here alongside it. The `app_settings` lookup for the
 * retained-earnings account was NOT scoped by company, on a view that has a
 * `company_id` column — one tenant's setting would have chosen another tenant's
 * equity account. And the account lookup was `LIMIT 1` with no ORDER BY, which
 * is a heap-order winner: with a code match and a name match both present,
 * which one you get depends on physical row order.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txSpy)),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sql } from '@/lib/neon';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const writes: string[] = [];
const txSpy = ((strings: TemplateStringsArray) => {
  writes.push(strings.join('?'));
  return Promise.resolve([{ id: 'je-1', entry_number: 'YE-2027' }]);
}) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = 'user-1';

function sqlText(i: number): string {
  const parts = mockSql.mock.calls[i]?.[0] as TemplateStringsArray | undefined;
  return (parts ?? ([] as unknown as TemplateStringsArray)).join(' ? ');
}

/** open-period probe → year range → revenue → expenses → app_settings → RE account. */
function mockReads(openPeriods: unknown[] = []): void {
  mockSql
    .mockResolvedValueOnce(openPeriods)
    .mockResolvedValueOnce([{ start_date: '2026-03-01', end_date: '2027-02-28' }])
    .mockResolvedValueOnce([
      { id: 'rev-1', account_code: '4000', account_name: 'Sales', balance: '1000000.00' },
    ])
    .mockResolvedValueOnce([
      { id: 'exp-1', account_code: '5000', account_name: 'Wages', balance: '400000.00' },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 're-1', account_code: '3200', account_name: 'Retained Earnings' }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
});

describe('closeFiscalYear — dry run', () => {
  it('returns the journal that WOULD post, and writes nothing', async () => {
    mockReads();

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });

    expect(writes).toHaveLength(0);
    expect(result).toMatchObject({ dryRun: true, netIncome: 600000 });
    if (!('preview' in result)) throw new Error('expected a preview');
    expect(result.preview.entryDate).toBe('2027-02-28');
    expect(result.preview.totalDebit).toBe(1000000);
    expect(result.preview.totalCredit).toBe(1000000);
  });

  it('shows every line of the journal, not a count', async () => {
    mockReads();
    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    if (!('preview' in result)) throw new Error('expected a preview');

    expect(result.preview.lines).toEqual([
      { accountId: 'rev-1', accountCode: '4000', accountName: 'Sales', debit: 1000000, credit: 0 },
      { accountId: 'exp-1', accountCode: '5000', accountName: 'Wages', debit: 0, credit: 400000 },
      {
        accountId: 're-1', accountCode: '3200', accountName: 'Retained Earnings',
        debit: 0, credit: 600000,
      },
    ]);
  });

  it('debits retained earnings on a loss', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ start_date: '2026-03-01', end_date: '2027-02-28' }])
      .mockResolvedValueOnce([{ id: 'rev-1', account_code: '4000', account_name: 'Sales', balance: '100.00' }])
      .mockResolvedValueOnce([{ id: 'exp-1', account_code: '5000', account_name: 'Wages', balance: '500.00' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 're-1', account_code: '3200', account_name: 'Retained Earnings' }]);

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    if (!('preview' in result)) throw new Error('expected a preview');

    expect(result.netIncome).toBe(-400);
    expect(result.preview.lines[2]).toMatchObject({ accountId: 're-1', debit: 400, credit: 0 });
    expect(result.preview.totalDebit).toBe(result.preview.totalCredit);
  });

  it('NAMES the periods blocking the close, not just how many', async () => {
    mockSql.mockResolvedValueOnce([
      { id: 'p1', period_name: 'March 2026', period_number: 1 },
      { id: 'p2', period_name: 'April 2026', period_number: 2 },
    ]);

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });

    expect(result).toMatchObject({ error: 'open_periods', count: 2 });
    if (!('openPeriods' in result)) throw new Error('expected the open periods');
    expect(result.openPeriods.map((p) => p.periodName)).toEqual(['March 2026', 'April 2026']);
  });

  it('refuses on open periods on the DRY RUN as well as the live call', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'p1', period_name: 'March 2026', period_number: 1 }]);
    const dry = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(dry).toMatchObject({ error: 'open_periods' });
    expect(writes).toHaveLength(0);
  });

  it('reports a missing retained-earnings account on the dry run', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ start_date: '2026-03-01', end_date: '2027-02-28' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(result).toMatchObject({ error: 'no_retained_earnings', accountCode: '3200' });
  });
});

describe('closeFiscalYear — tenant scoping and determinism', () => {
  it('scopes the app_settings lookup by company_id', async () => {
    mockReads();
    await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    // app_settings is a VIEW carrying company_id. Unscoped, one tenant's
    // setting picks another tenant's equity account.
    expect(sqlText(4)).toMatch(/app_settings/);
    expect(sqlText(4)).toMatch(/company_id/);
    expect(mockSql.mock.calls[4]?.slice(1)).toContain(COMPANY);
  });

  it('orders the retained-earnings lookup so it cannot be decided by heap order', async () => {
    mockReads();
    await closeFiscalYear(COMPANY, '2027', USER, { dryRun: true });
    expect(sqlText(5)).toMatch(/ORDER BY/);
    expect(sqlText(5)).toMatch(/company_id/);
  });

  it('still writes the journal on a live call', async () => {
    mockReads();
    const result = await closeFiscalYear(COMPANY, '2027', USER);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((w) => w.includes('gl_journal_entries'))).toBe(true);
    expect(writes.some((w) => w.includes('UPDATE fiscal_periods'))).toBe(true);
    expect(result).toMatchObject({ netIncome: 600000 });
  });
});
