/**
 * Regression guard for the NULL-subtype footgun in the management-accounts
 * cash-flow summary.
 *
 * The investing-activities query selects assets that are neither cash nor
 * receivables. Written as `NOT (account_subtype = ANY(...))`, that expression
 * evaluates to NULL — not TRUE — for the 102 production asset accounts whose
 * subtype is NULL, so every unclassified asset silently vanishes from
 * investing activities. Measured on Velocity Fibre: −21,829,521.14 with the
 * NULL-unsafe form against −54,582,068.52 with the correct one, a R32.75m
 * difference. `COALESCE(account_subtype, '') <> ALL(...)` is NULL-safe.
 *
 * DB is mocked — no live connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/reports/incomeStatementService', () => ({
  getIncomeStatement: vi.fn(async () => ({ revenue: [], costOfSales: [], operatingExpenses: [] })),
}));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({
  getBalanceSheet: vi.fn(async () => ({ assets: [], liabilities: [], equity: [] })),
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import { sql } from '@/lib/neon';
import handler from '../../../pages/api/accounting/reports-management-accounts';
import type { NextApiRequest, NextApiResponse } from 'next';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

/** Joined template text with SQL comments stripped, so assertions cannot match prose. */
function queryTexts(): string[] {
  return mockSql.mock.calls.map((c) =>
    (c[0] as unknown as string[])
      .join(' ? ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' '),
  );
}

function mockReqRes() {
  const req = {
    method: 'GET',
    query: { period_start: '2026-01-01', period_end: '2026-12-31' },
    companyId: '11111111-1111-4111-8111-111111111111',
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 200,
    status(c: number) { this.statusCode = c; return this; },
    json() { return this; },
    setHeader() { return this; },
    send() { return this; },
  } as unknown as NextApiResponse;
  return { req, res };
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

describe('management accounts cash-flow summary', () => {
  it('selects non-cash, non-receivable assets NULL-safely', async () => {
    const { req, res } = mockReqRes();
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);

    const investing = queryTexts().filter((t) => t.includes('<> ALL'));
    expect(investing.length).toBeGreaterThan(0);
    // The NULL-unsafe idiom must not come back.
    for (const t of queryTexts()) {
      expect(t).not.toMatch(/NOT\s*\(\s*ga\.account_subtype\s*=\s*ANY/);
    }
  });

  it('classifies cash, receivables and payables by subtype, never by account name', async () => {
    const { req, res } = mockReqRes();
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);

    for (const t of queryTexts()) {
      expect(t).not.toMatch(/account_name\s+I?LIKE/i);
      expect(t).not.toMatch(/account_name\s+NOT\s+I?LIKE/i);
    }
    const params = mockSql.mock.calls.flatMap((c) => c.slice(1)).filter(Array.isArray).flat();
    expect(params).toContain('bank');
    expect(params).toContain('cash');
    expect(params).toContain('receivable');
    expect(params).toContain('payable');
  });

  it('excludes retained earnings from financing NULL-safely', async () => {
    const { req, res } = mockReqRes();
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
    const financing = queryTexts().filter((t) =>
      t.includes("IS DISTINCT FROM 'retained_earnings'"),
    );
    expect(financing.length).toBeGreaterThan(0);
  });
});
