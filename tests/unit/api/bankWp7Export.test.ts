/**
 * WP7: GET /api/accounting/bank-transactions-export is bounded like the all-accounts export: real ledger dates, a BANK
 * account of this company only, a row cap (400 beyond it), and the per-company report rate limit (429).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute } from '../helpers/apiRouteCall';

const getBankTransactions = vi.fn();
const sqlMock = vi.fn();
const rate = vi.fn();
vi.mock('@/modules/accounting/services/reports/transactionReportingService', () => ({ getBankTransactions: (...a: unknown[]) => getBankTransactions(...a) }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: (...a: unknown[]) => rate(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler, { BANK_TX_LEDGER_EXPORT_MAX_ROWS } from '../../../pages/api/accounting/bank-transactions-export';

const report = (n: number) => ({
  openingBalance: 0, closingBalance: 0,
  transactions: Array.from({ length: n }, (_, i) => ({ date: '2026-01-02', entryNumber: `J${i}`, description: 'x', deposit: 1, withdrawal: 0, runningBalance: i })),
});
const q = { period_start: '2026-01-01', period_end: '2026-01-31', account_code: '1110' };

beforeEach(() => {
  getBankTransactions.mockReset().mockResolvedValue(report(2));
  sqlMock.mockReset().mockResolvedValue([{ ok: 1 }]); // the account is a bank account
  rate.mockReset().mockResolvedValue(true);
});

describe('bank-transactions-export', () => {
  it('serves the CSV for a bank account, asking for one row past the cap', async () => {
    const r = await callRoute(handler, { query: q });
    expect(r.code).toBe(200);
    expect(getBankTransactions).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', '2026-01-01', '2026-01-31', '1110', BANK_TX_LEDGER_EXPORT_MAX_ROWS + 1);
  });

  it('an account that is not a bank account of this company is a 400, and no ledger is read', async () => {
    sqlMock.mockResolvedValue([]);
    const r = await callRoute(handler, { query: { ...q, account_code: '6100' } });
    expect(r.code).toBe(400);
    expect(String((r.body as { error?: { message?: string } })?.error?.message ?? JSON.stringify(r.body))).toMatch(/bank accounts/);
    expect(getBankTransactions).not.toHaveBeenCalled();
  });

  it('the account lookup is scoped to the company and to the bank subtypes', async () => {
    await callRoute(handler, { query: q });
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    expect((strings as string[]).join('?')).toMatch(/company_id = \?::UUID/);
    expect((strings as string[]).join('?')).toMatch(/account_subtype = ANY/);
    expect(values).toContain('aaaaaaaa-0000-4000-8000-000000000001');
    expect(values.some((v) => Array.isArray(v) && v.includes('bank'))).toBe(true);
  });

  it('more rows than the cap is a 400 (narrow the period), not a giant file', async () => {
    getBankTransactions.mockResolvedValue(report(BANK_TX_LEDGER_EXPORT_MAX_ROWS + 1));
    const r = await callRoute(handler, { query: q });
    expect(r.code).toBe(400);
  });

  it('exactly the cap is served', async () => {
    getBankTransactions.mockResolvedValue(report(BANK_TX_LEDGER_EXPORT_MAX_ROWS));
    expect((await callRoute(handler, { query: q })).code).toBe(200);
  });

  it('over the rate limit is a 429 and nothing is read', async () => {
    rate.mockResolvedValue(false);
    const r = await callRoute(handler, { query: q });
    expect(r.code).toBe(429);
    expect(getBankTransactions).not.toHaveBeenCalled();
    expect(rate).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', 'bank-transactions-export');
  });

  it('an inverted range is a 400, not an empty export', async () => {
    const r = await callRoute(handler, { query: { ...q, period_start: '2026-02-01', period_end: '2026-01-01' } });
    expect(r.code).toBe(400);
    expect(getBankTransactions).not.toHaveBeenCalled();
    expect((await callRoute(handler, { query: { ...q, period_start: '2026-01-31', period_end: '2026-01-31' } })).code).toBe(200); // one day is fine
  });

  it.each([['not a date', { period_start: 'yesterday' }], ['impossible date', { period_end: '2026-02-30' }], ['repeated', { period_start: ['2026-01-01', '2026-01-02'] }]])(
    '%s is a 400', async (_n, patch) => {
      expect((await callRoute(handler, { query: { ...q, ...patch } })).code).toBe(400);
      expect(getBankTransactions).not.toHaveBeenCalled();
    });
});
