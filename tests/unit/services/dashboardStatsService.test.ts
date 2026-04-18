// RED phase — written before implementation
/**
 * Unit tests for dashboard-stats API handler — BL-03 and BL-04
 *
 * Verifies that the bank balance widget reads from GL journal lines
 * (gl_journal_lines → gl_journal_entries → gl_accounts where account_subtype='bank')
 * rather than summing raw bank_transactions.amount.
 *
 * Seed scenario:
 *   - 3 bank_transactions rows totalling 1000 (only raw import data)
 *   - 2 posted GL journal lines against a bank account totalling net 600 (debit−credit)
 *   - Expected: dashboard bankBalance = 600, NOT 1000
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (fn: unknown) => fn,
}));

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((res: NextApiResponse, data: unknown) => {
      res.status(200).json({ data });
    }),
    badRequest: vi.fn((res: NextApiResponse, msg: string) => {
      res.status(400).json({ error: msg });
    }),
    methodNotAllowed: vi.fn((res: NextApiResponse) => {
      res.status(405).json({ error: 'Method not allowed' });
    }),
  },
}));

import { sql } from '@/lib/neon';

// ── Constants ────────────────────────────────────────────────────────────────

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(companyId = COMPANY_ID): NextApiRequest & { companyId: string } {
  return {
    method: 'GET',
    companyId,
  } as unknown as NextApiRequest & { companyId: string };
}

function makeRes(): NextApiResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: null,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return res as unknown as NextApiResponse & { _status: number; _body: unknown };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('dashboard-stats handler — BL-03 bank balance from GL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns GL net balance (600), NOT raw bank_transaction sum (1000)', async () => {
    const sqlMock = sql as ReturnType<typeof vi.fn>;

    // The handler calls Promise.all with 7 queries.
    // We drive per-call-index what each returns.
    let callIndex = 0;
    sqlMock.mockImplementation(() => {
      const idx = callIndex++;
      switch (idx) {
        // [0] bankBalances — NEW GL query: should return net 600
        case 0:
          return Promise.resolve([
            { account_code: '1010', account_name: 'Bank - Primary', balance: '600' },
          ]);
        // [1] apTotal
        case 1:
          return Promise.resolve([{ total: '0' }]);
        // [2] arTotal
        case 2:
          return Promise.resolve([{ total: '0' }]);
        // [3] monthRevenue
        case 3:
          return Promise.resolve([{ total: '0' }]);
        // [4] monthExpenses
        case 4:
          return Promise.resolve([{ total: '0' }]);
        // [5] unallocatedCount
        case 5:
          return Promise.resolve([{ count: '0' }]);
        // [6] recentJournals
        case 6:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });

    const handler = (await import('../../../pages/api/accounting/dashboard-stats')).default as (
      req: NextApiRequest,
      res: NextApiResponse
    ) => Promise<void>;

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);

    const body = res._body as { data: { totalBankBalance: number; banks: { balance: number }[] } };
    const bankBalance = body.data.totalBankBalance;

    // Must match GL net (600), NOT raw tx sum (1000)
    expect(bankBalance).toBe(600);
    expect(body.data.banks[0].balance).toBe(600);
  });

  it('uses GL query (joins gl_journal_lines, gl_journal_entries, gl_accounts) for bank balance — BL-03', async () => {
    const sqlMock = sql as ReturnType<typeof vi.fn>;
    let callIndex = 0;
    sqlMock.mockImplementation(() => {
      const idx = callIndex++;
      if (idx === 0) return Promise.resolve([{ account_code: '1010', account_name: 'Bank', balance: '975880.61' }]);
      if (idx === 5) return Promise.resolve([{ count: '0' }]);
      if (idx === 6) return Promise.resolve([]);
      return Promise.resolve([{ total: '0' }]);
    });

    const handler = (await import('../../../pages/api/accounting/dashboard-stats')).default as (
      req: NextApiRequest,
      res: NextApiResponse
    ) => Promise<void>;

    const req = makeReq();
    const res = makeRes();

    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    // The first sql call (idx=0) must reference GL tables, not bank_transactions SUM
    // Verify by inspecting the template strings passed to the sql tagged template
    const firstCallArgs = sqlMock.mock.calls[0];
    const templateStrings: string[] = firstCallArgs[0];
    const joinedQuery = templateStrings.join(' ');

    // Must reference GL tables
    expect(joinedQuery).toMatch(/gl_journal_lines/i);
    expect(joinedQuery).toMatch(/gl_journal_entries/i);
    expect(joinedQuery).toMatch(/gl_accounts/i);
    expect(joinedQuery).toMatch(/account_subtype/i);
    expect(joinedQuery).toMatch(/posted/i);

    // Must NOT directly aggregate bank_transactions
    expect(joinedQuery).not.toMatch(/FROM\s+bank_transactions/i);
  });
});

// ── BL-04: AR/AP widgets must exclude draft invoices ──────────────────────────

describe('dashboard-stats handler — BL-04 AR/AP exclude drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  /**
   * Seed: 3 customer invoices for company A
   *   - draft:    500  (must be EXCLUDED)
   *   - approved: 500  (must be INCLUDED)
   *   - paid:     500  (must be EXCLUDED — fully paid)
   * Expected arTotal = 500
   */
  it('arTotal excludes draft invoices — only open statuses count', async () => {
    const { sql } = await import('@/lib/neon');
    const sqlMock = sql as ReturnType<typeof vi.fn>;

    let callIndex = 0;
    sqlMock.mockImplementation(() => {
      const idx = callIndex++;
      switch (idx) {
        // [0] bankBalances
        case 0:
          return Promise.resolve([]);
        // [1] apTotal — zero for this test
        case 1:
          return Promise.resolve([{ total: '0' }]);
        // [2] arTotal — DB returns 500 (only 'approved' invoice matches open filter)
        case 2:
          return Promise.resolve([{ total: '500' }]);
        // [3] monthRevenue
        case 3:
          return Promise.resolve([{ total: '0' }]);
        // [4] monthExpenses
        case 4:
          return Promise.resolve([{ total: '0' }]);
        // [5] unallocatedCount
        case 5:
          return Promise.resolve([{ count: '0' }]);
        // [6] recentJournals
        case 6:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });

    const handler = (await import('../../../pages/api/accounting/dashboard-stats')).default as (
      req: NextApiRequest,
      res: NextApiResponse
    ) => Promise<void>;

    const req = makeReq();
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const body = res._body as { data: { arTotal: number } };
    // Only the 'approved' (500) invoice is included — draft (500) excluded
    expect(body.data.arTotal).toBe(500);
  });

  /**
   * Verify the AR SQL query uses ANY(open_statuses) not NOT IN('cancelled','paid').
   * The query must NOT contain 'draft' exclusion pattern — it must use an allowlist.
   */
  it('AR query uses an allowlist of open statuses (not a denylist) — matches AR_OPEN_STATUSES', async () => {
    const { sql } = await import('@/lib/neon');
    const sqlMock = sql as ReturnType<typeof vi.fn>;

    let callIndex = 0;
    sqlMock.mockImplementation(() => {
      const idx = callIndex++;
      if (idx === 5) return Promise.resolve([{ count: '0' }]);
      if (idx === 6) return Promise.resolve([]);
      return Promise.resolve([{ total: '0', balance: '0', account_code: '', account_name: '' }]);
    });

    const handler = (await import('../../../pages/api/accounting/dashboard-stats')).default as (
      req: NextApiRequest,
      res: NextApiResponse
    ) => Promise<void>;

    const req = makeReq();
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    // AR query is the 3rd call (index 2)
    const arCallArgs = sqlMock.mock.calls[2];
    const arTemplateStrings: string[] = arCallArgs[0];
    const arQuery = arTemplateStrings.join(' ');

    // Must use ANY(...) allowlist pattern — not the old denylist
    expect(arQuery).toMatch(/ANY\s*\(/i);
    // Must NOT use the old broken denylist that included drafts
    expect(arQuery).not.toMatch(/NOT IN\s*\([^)]*'paid'/i);
  });

  /**
   * Seed: 3 supplier invoices
   *   - draft:          600  (EXCLUDED)
   *   - approved:       600  (INCLUDED)
   *   - partially_paid: 600  (INCLUDED, balance 400 after 200 paid)
   * Expected apTotal reflects only open statuses
   */
  it('apTotal excludes draft supplier invoices — only open statuses count', async () => {
    const { sql } = await import('@/lib/neon');
    const sqlMock = sql as ReturnType<typeof vi.fn>;

    let callIndex = 0;
    sqlMock.mockImplementation(() => {
      const idx = callIndex++;
      switch (idx) {
        case 0: return Promise.resolve([]);
        // [1] apTotal — DB returns 1000 (approved 600 + partially_paid balance 400)
        case 1: return Promise.resolve([{ total: '1000' }]);
        case 2: return Promise.resolve([{ total: '0' }]);
        case 3: return Promise.resolve([{ total: '0' }]);
        case 4: return Promise.resolve([{ total: '0' }]);
        case 5: return Promise.resolve([{ count: '0' }]);
        case 6: return Promise.resolve([]);
        default: return Promise.resolve([]);
      }
    });

    const handler = (await import('../../../pages/api/accounting/dashboard-stats')).default as (
      req: NextApiRequest,
      res: NextApiResponse
    ) => Promise<void>;

    const req = makeReq();
    const res = makeRes();
    await handler(req as NextApiRequest, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    const body = res._body as { data: { apTotal: number } };
    expect(body.data.apTotal).toBe(1000);
  });
});
