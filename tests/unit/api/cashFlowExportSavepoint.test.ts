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

  it('leaves the cash accounts out of the movement by subtype (every spelling) and scopes it to the company', async () => {
    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    // One grouped query over the non-cash accounts; the classification into lines is in TypeScript through the
    // subtype vocabulary (cashFlowIndirectClassification.test.ts walks it, the plural fixed_assets included).
    const movement = queryTexts().filter((t) => t.includes('GROUP BY l.account_type, l.account_subtype'));
    expect(movement).toHaveLength(1);
    expect(movement[0]).toMatch(/\(ga\.account_type = 'asset' AND COALESCE\(ga\.account_subtype = ANY\(/);
    expect(movement[0]).toMatch(/WHERE NOT l\.is_cash/);
    const params = sqlMock.mock.calls.flatMap((c) => c.slice(1));
    const lists = params.filter(Array.isArray).flat();
    for (const spelling of ['bank', 'bank_account', 'cash', 'petty_cash']) expect(lists).toContain(spelling);
    expect(params).toContain('co-1');
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
