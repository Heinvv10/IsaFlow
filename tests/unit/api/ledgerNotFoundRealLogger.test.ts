/**
 * Round 8: the logger is REAL here (only the database is faked). A detached `log.warn` call lost
 * `this` and turned every error in the two ledger services into a TypeError / 500, and a test with
 * the logger mocked could not see it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true), checkRateLimit: vi.fn(async () => true) }));

import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/accountTransactionsService';
import { LedgerAccountNotFoundError } from '@/modules/accounting/services/gl/ledgerErrors';
import accountLedger from '../../../pages/api/accounting/reports-account-ledger';

const C = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
beforeEach(() => { sqlMock.mockReset(); });

function call(query: Record<string, unknown>) {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; }, send(b: unknown) { this.body = b; return this; }, setHeader() { return this; } };
  const req = { method: 'GET', query, companyId: C, headers: {}, url: '/x', socket: {} } as unknown as NextApiRequest;
  return (accountLedger as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse)
    .then(() => res, (e: unknown) => ({ statusCode: 'threw', body: e }));
}

describe('the ledger services with the real logger', () => {
  it('a nonexistent account is a LedgerAccountNotFoundError (not a logger TypeError), in both services', async () => {
    sqlMock.mockResolvedValue([]);
    await expect(getAccountLedger({ companyId: C, accountId: ACCOUNT, fromDate: '2026-01-01', toDate: '2026-09-30' })).rejects.toBeInstanceOf(LedgerAccountNotFoundError);
    await expect(getAccountTransactions(C, 'nope', '2026-01-01', '2026-09-30')).rejects.toBeInstanceOf(LedgerAccountNotFoundError);
  }, 5000);

  it('an unexpected failure surfaces as itself, not as a logger TypeError, in both services', async () => {
    sqlMock.mockRejectedValue(new Error('db down'));
    await expect(getAccountLedger({ companyId: C, accountId: ACCOUNT, fromDate: '2026-01-01', toDate: '2026-09-30' })).rejects.toThrow('db down');
    await expect(getAccountTransactions(C, 'x', '2026-01-01', '2026-09-30')).rejects.toThrow('db down');
  }, 5000);

  it('route: a nonexistent account id is a 404 "Account not found"', async () => {
    sqlMock.mockResolvedValue([]);
    const res = await call({ account_id: ACCOUNT, from: '2026-01-01', to: '2026-09-30' });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).toContain('Account not found');
  }, 5000);

  it('route: an unexpected service error is a 500 about THAT error, not a logger TypeError', async () => {
    sqlMock.mockRejectedValue(new Error('db down'));
    const res = await call({ account_id: ACCOUNT, from: '2026-01-01', to: '2026-09-30' });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('reading');
    expect(JSON.stringify(res.body)).not.toContain('TypeError');
  }, 5000);
});
