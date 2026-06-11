/**
 * Audit P2 carry-over: the cash-flow export's account_subtype column probe
 * was a bare try/catch around a SELECT. Inside withAuth's request-wide
 * transaction a failed probe aborts the tx, so every fallback query after it
 * 500s. The probe must run inside a savepoint.
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cash-flow-export account_subtype probe', () => {
  it('runs the probe inside a savepoint and survives a missing column', async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('account_subtype FROM gl_accounts LIMIT 1')) {
        throw new Error('column "account_subtype" does not exist');
      }
      return [];
    });

    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(withSavepointMock.mock.calls.map((c) => c[0])).toContain('subtype_probe');
    expect(res.statusCode).toBe(200);
    expect(String(res.sent)).toContain('Operating Activities');
  });

  it('uses the subtype queries when the column exists', async () => {
    sqlMock.mockImplementation(async () => []);

    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(200);
    const subtypeQueries = sqlMock.mock.calls.filter((c) =>
      (c[0] as readonly string[]).join('?').includes("account_subtype = 'bank'"),
    );
    expect(subtypeQueries.length).toBeGreaterThan(0);
  });
});
