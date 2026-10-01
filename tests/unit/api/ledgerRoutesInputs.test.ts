/**
 * Round 4 (breaker T2): hostile paging input, an inverted range, and an account that is not
 * this company's must produce a 400 / 404 — never a 500 from a bigint cast, a 200 with a
 * closing row dated before its opening row, or a bare "not found" error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({
  getGeneralLedgerReport: vi.fn(async () => []),
  getAccountTransactions: vi.fn(async () => ({ transactions: [], openingBalance: 0, closingBalance: 0 })),
  getAccountLedger: vi.fn(async () => ({ rows: [], total: 0 })),
}));
vi.mock('@/modules/accounting/services/gl/generalLedgerReportService', () => ({ getGeneralLedgerReport: svc.getGeneralLedgerReport }));
vi.mock('@/modules/accounting/services/reports/transactionReportingService', () => ({ getAccountTransactions: svc.getAccountTransactions }));
vi.mock('@/modules/accounting/services/reports/accountLedgerService', () => ({ getAccountLedger: svc.getAccountLedger }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true), checkRateLimit: vi.fn(async () => true) }));

import { LedgerAccountNotFoundError } from '@/modules/accounting/services/gl/ledgerErrors';
import generalLedger from '../../../pages/api/accounting/reports-general-ledger';
import accountTransactions from '../../../pages/api/accounting/reports-account-transactions';
import transactionsExport from '../../../pages/api/accounting/account-transactions-export';
import accountLedger from '../../../pages/api/accounting/reports-account-ledger';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const call = (handler: unknown, query: Record<string, unknown>) => {
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; }, send() { return this; }, setHeader() { return this; } };
  return (handler as Handler)({ method: 'GET', query, companyId: 'c1' } as unknown as NextApiRequest, res as unknown as NextApiResponse)
    .then(() => res.statusCode);
};
const led = (extra: Record<string, unknown> = {}) => ({ account_code: '5000', from: '2026-01-01', to: '2026-09-30', ...extra });
const none = () => Object.values(svc).every(m => m.mock.calls.length === 0);

beforeEach(() => { Object.values(svc).forEach(m => { m.mockClear(); }); });

describe('reports-account-ledger paging parameters', () => {
  it.each(['10000000000000000000', '1000000000000000000000000000000', '9000000000000000000', '1.5', '-1', 'abc', '1e3', '', '10000001'])(
    'offset %j is refused', async (offset) => {
      expect(await call(accountLedger, led({ offset }))).toBe(400);
      expect(none()).toBe(true);
    }, 5000);

  it.each(['0', '1.5', '501', '-5', '1e3', 'x', '1000000000000000000000'])('limit %j is refused', async (limit) => {
    expect(await call(accountLedger, led({ limit }))).toBe(400);
    expect(none()).toBe(true);
  }, 5000);

  it('refuses a repeated (array) parameter', async () => {
    expect(await call(accountLedger, led({ offset: ['1', '2'] }))).toBe(400);
    expect(await call(accountLedger, led({ limit: ['1', '2'] }))).toBe(400);
    expect(none()).toBe(true);
  }, 5000);

  it('serves sane values', async () => {
    expect(await call(accountLedger, led({ offset: '200', limit: '200' }))).toBe(200);
    expect(await call(accountLedger, led({ offset: '10000000', limit: '500' }))).toBe(200);
  }, 5000);
});

describe('an inverted range is a 400 on every ledger route', () => {
  it.each([
    ['reports-general-ledger', generalLedger, { period_start: '2026-09-30', period_end: '2026-01-01' }],
    ['reports-account-transactions', accountTransactions, { account_code: '5000', period_start: '2026-09-30', period_end: '2026-01-01' }],
    ['account-transactions-export', transactionsExport, { account_code: '5000', period_start: '2026-09-30', period_end: '2026-01-01' }],
    ['reports-account-ledger', accountLedger, { account_code: '5000', from: '2026-09-30', to: '2026-01-01' }],
  ])('%s', async (_n, handler, query) => {
    expect(await call(handler, query)).toBe(400);
    expect(none()).toBe(true);
  }, 5000);

  it('a one-day range (from = to) is fine', async () => {
    expect(await call(generalLedger, { period_start: '2026-09-30', period_end: '2026-09-30' })).toBe(200);
  }, 5000);
});

describe('an account that is not this company\'s is a 404 (identical for missing and foreign)', () => {
  it.each([
    ['reports-account-ledger', accountLedger, led({ account_id: '11111111-1111-4111-8111-111111111111', account_code: undefined }), svc.getAccountLedger],
    ['reports-account-transactions', accountTransactions, { account_code: 'nope', period_start: '2026-01-01', period_end: '2026-09-30' }, svc.getAccountTransactions],
    ['account-transactions-export', transactionsExport, { account_code: 'nope', period_start: '2026-01-01', period_end: '2026-09-30' }, svc.getAccountTransactions],
  ])('%s', async (_n, handler, query, service) => {
    (service as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new LedgerAccountNotFoundError('whatever'));
    expect(await call(handler, query)).toBe(404);
  }, 5000);

  it('a different failure is still not a 404', async () => {
    svc.getAccountLedger.mockRejectedValueOnce(new Error('boom'));
    await expect(call(accountLedger, led())).rejects.toThrow('boom');
  }, 5000);
});

describe('a NUL byte in any string query parameter is a 400 before any service runs', () => {
  const NUL = '50\u000000';
  it.each([
    ['reports-account-ledger', accountLedger, led({ account_code: NUL })],
    ['reports-account-ledger (array element)', accountLedger, led({ account_code: ['5000', NUL] })],
    ['reports-account-transactions', accountTransactions, { account_code: NUL, period_start: '2026-01-01', period_end: '2026-09-30' }],
    ['account-transactions-export', transactionsExport, { account_code: NUL, period_start: '2026-01-01', period_end: '2026-09-30' }],
    ['reports-general-ledger', generalLedger, { period_start: '2026-01-01', period_end: '2026-09-30', other: NUL }],
  ])('%s', async (_n, handler, query) => {
    expect(await call(handler, query)).toBe(400);
    expect(none()).toBe(true);
  }, 5000);
});

