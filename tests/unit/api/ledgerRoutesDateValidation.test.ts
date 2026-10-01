/**
 * R8/R9 (breaker, PR #595): a period date with a leading space, unpadded month or day, an
 * impossible calendar date, or an absurd year used to reach the year-end walk (a leading
 * space once looped it forever). Every ledger route must answer 400 BEFORE any service runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const services = vi.hoisted(() => ({
  getGeneralLedgerReport: vi.fn(async () => []),
  getAccountTransactions: vi.fn(async () => ({ transactions: [], openingBalance: 0, closingBalance: 0 })),
  getAccountLedger: vi.fn(async () => ({ rows: [], total: 0 })),
}));
vi.mock('@/modules/accounting/services/gl/generalLedgerReportService', () => ({ getGeneralLedgerReport: services.getGeneralLedgerReport }));
vi.mock('@/modules/accounting/services/reports/transactionReportingService', () => ({ getAccountTransactions: services.getAccountTransactions }));
vi.mock('@/modules/accounting/services/reports/accountLedgerService', () => ({ getAccountLedger: services.getAccountLedger }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true), checkRateLimit: vi.fn(async () => true) }));

import generalLedger from '../../../pages/api/accounting/reports-general-ledger';
import accountTransactions from '../../../pages/api/accounting/reports-account-transactions';
import transactionsExport from '../../../pages/api/accounting/account-transactions-export';
import accountLedger from '../../../pages/api/accounting/reports-account-ledger';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

const routes: Array<[string, Handler, (from: unknown, to: unknown) => Record<string, unknown>]> = [
  ['reports-general-ledger', generalLedger as Handler, (a, b) => ({ period_start: a, period_end: b })],
  ['reports-account-transactions', accountTransactions as Handler, (a, b) => ({ account_code: '5200', period_start: a, period_end: b })],
  ['account-transactions-export', transactionsExport as Handler, (a, b) => ({ account_code: '5200', period_start: a, period_end: b })],
  ['reports-account-ledger', accountLedger as Handler, (a, b) => ({ account_id: ACCOUNT, from: a, to: b })],
];

function call(handler: Handler, query: Record<string, unknown>) {
  const res = {
    statusCode: 0,
    status(c: number) { this.statusCode = c; return this; },
    json() { return this; }, send() { return this; }, setHeader() { return this; },
  };
  const req = { method: 'GET', query, companyId: 'c1' } as unknown as NextApiRequest;
  return handler(req, res as unknown as NextApiResponse).then(() => res.statusCode);
}

const BAD: Array<[string, unknown]> = [
  ['leading space', ' 2026-01-01'],
  ['unpadded month/day', '2026-1-15'],
  ['impossible date', '2026-02-31'],
  ['year below 1900', '1000-01-01'],
  ['year above 2200', '9999-12-31'],
  ['timestamp', '2026-01-01T00:00:00Z'],
  ['repeated param (array)', ['2026-01-01', '2026-02-01']],
];

describe.each(routes)('%s rejects a bad period date with 400 before any service runs', (_name, handler, q) => {
  beforeEach(() => { Object.values(services).forEach(m => m.mockClear()); });

  it.each(BAD)('%s as the start', async (_label, bad) => {
    expect(await call(handler, q(bad, '2026-09-30'))).toBe(400);
    expect(Object.values(services).every(m => m.mock.calls.length === 0)).toBe(true);
  }, 5000);

  it.each(BAD)('%s as the end', async (_label, bad) => {
    expect(await call(handler, q('2026-01-01', bad))).toBe(400);
    expect(Object.values(services).every(m => m.mock.calls.length === 0)).toBe(true);
  }, 5000);

  it('still serves a good range', async () => {
    expect(await call(handler, q('2026-01-01', '2026-09-30'))).toBe(200);
  }, 5000);
});
