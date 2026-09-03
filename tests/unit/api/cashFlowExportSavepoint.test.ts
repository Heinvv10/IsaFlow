/**
 * Audit P2 carry-over, then the reporting audit.
 *
 * This endpoint used to probe for the `account_subtype` column and, if the
 * probe failed, fall back to classifying accounts by NAME —
 * `account_name ILIKE '%bank%'`, `'%receivable%'`, `'%payable%'`. That fallback
 * produced the figures the reporting audit found: opening cash of
 * R14,081,940.13 against a true R234,353.19 on Velocity Fibre, because the
 * `PC - Paycard - …` and `ABSA - PC : …` bank accounts contain neither "bank"
 * nor "cash" in their names.
 *
 * The column has existed since migration 260+, so the branch was unreachable by
 * design — but the probe's `.catch(() => false)` meant any transient fault
 * silently routed a live request down it and answered 200 with wrong numbers.
 * Both the probe and the fallback are now gone: classification is by subtype
 * only, and a genuine schema or connection fault surfaces as an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
const withSavepointMock = vi.fn(async (name: string, fn: () => Promise<unknown>) => fn());
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
  withSavepoint: (name: string, fn: () => Promise<unknown>) => withSavepointMock(name, fn),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/cash-flow-export';

function mockReqRes() {
  const req = {
    method: 'GET',
    query: { period_start: '2026-01-01', period_end: '2026-01-31' },
    companyId: 'co-1',
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

/** Joined template text with SQL comments stripped, so assertions read the query, not prose. */
function queryTexts(): string[] {
  return sqlMock.mock.calls.map((c) =>
    (c[0] as readonly string[])
      .join('?')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' '),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(async () => []);
});

describe('cash-flow-export classification', () => {
  it('produces the report and never probes for the account_subtype column', async () => {
    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(200);
    expect(String(res.sent)).toContain('Operating Activities');

    // The probe existed only to choose between branches. With one branch left
    // it is dead weight whose failure mode was silent wrongness.
    expect(withSavepointMock).not.toHaveBeenCalled();
    for (const t of queryTexts()) {
      expect(t).not.toMatch(/SELECT account_subtype FROM gl_accounts LIMIT 1/);
    }
  });

  it('carries no name-matching classification anywhere', async () => {
    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    for (const t of queryTexts()) {
      expect(t).not.toMatch(/account_name\s+(NOT\s+)?I?LIKE/i);
    }
  });

  it('classifies cash, receivables, payables and investing assets by subtype', async () => {
    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    const subtypeQueries = queryTexts().filter((t) => t.includes('account_subtype = ANY('));
    expect(subtypeQueries.length).toBeGreaterThanOrEqual(4);

    const params = sqlMock.mock.calls.flatMap((c) => c.slice(1)).filter(Array.isArray).flat();
    expect(params).toContain('bank');
    expect(params).toContain('cash');
    expect(params).toContain('receivable');
    expect(params).toContain('payable');
    expect(params).toContain('fixed_asset');
    // The plural spelling is 30 accounts in production.
    expect(params).toContain('fixed_assets');
  });

  it('surfaces a query fault instead of answering with downgraded numbers', async () => {
    sqlMock.mockImplementation(async () => {
      throw new Error('connection reset');
    });

    const { req, res } = mockReqRes();
    await expect(
      (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res),
    ).rejects.toThrow(/connection reset/);
  });
});
