import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/modules/accounting/services/reports/transactionReportingService', () => ({
  getAccountTransactions: vi.fn(async () => ({
    openingBalance: 100, closingBalance: 12,
    transactions: [
      { date: '2025-02-10', entryNumber: 'JE1', description: 'sale', debit: 0, credit: 30, balance: 130, source: 'manual' },
      { date: '2025-02-28', entryNumber: '', description: 'Closed (derived — not posted)', debit: 130, credit: 0, balance: 0, source: 'year_end_close', derived: true },
    ],
  })),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));

import handler from '../../../pages/api/accounting/account-transactions-export';

describe('account-transactions-export marks derived rows in their own column', () => {
  it('has a Derived column: set on the close row only, blank on posted rows and sentinels', async () => {
    let body = '';
    const res = { status() { return this; }, setHeader() { return this; }, send(b: string) { body = b; return this; } };
    const req = { method: 'GET', companyId: 'c', query: { account_code: '5200', period_start: '2025-01-01', period_end: '2025-09-30' } };
    await (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    const rows = body.split('\n').map(l => l.split(',').map(f => f.replace(/"/g, '')));
    expect(rows[0]).toEqual(['Date', 'Entry Number', 'Description', 'Debit', 'Credit', 'Balance', 'Source', 'Derived']);
    expect(rows.map(r => r[7])).toEqual(['Derived', '', '', 'derived', '']);
    expect(new Set(rows.map(r => r.length)).size).toBe(1);
  }, 5000);
});
