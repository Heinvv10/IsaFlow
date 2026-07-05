/**
 * H5: the FAR report's query catch block used to swallow every error from
 * the main ledger query (including a bogus `asset_categories.company_id`
 * join condition that doesn't exist on that table — Postgres 42703) and
 * mask it behind a "run pending migrations" setupRequired payload, always
 * returning an empty report instead of surfacing the real bug. Only a
 * genuine "table not provisioned" error (42P01 undefined_table) should take
 * the empty-report fallback path; anything else must rethrow so
 * withErrorHandler returns an honest 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/assets/far-report';

function mockReqRes() {
  const req = {
    method: 'GET',
    query: { asAt: '2026-07-01' },
    companyId: 'co-1',
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

const LEDGER_EXISTS_ROW = [{ rel: 'asset_period_ledger' }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FAR report catch-block narrowing', () => {
  it('returns an empty report with setupRequired only for undefined_table (42P01)', async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('to_regclass')) return LEDGER_EXISTS_ROW;
      const err = new Error('relation "asset_period_ledger" does not exist') as Error & { code: string };
      err.code = '42P01';
      throw err;
    });

    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.sent as { data: { setupRequired?: string; assets: unknown[] } };
    expect(body.data.setupRequired).toMatch(/not fully provisioned/);
    expect(body.data.assets).toEqual([]);
  });

  it('rethrows any other error (e.g. undefined_column 42703) instead of masking it', async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('to_regclass')) return LEDGER_EXISTS_ROW;
      const err = new Error('column c.company_id does not exist') as Error & { code: string };
      err.code = '42703';
      throw err;
    });

    const { req, res } = mockReqRes();
    await expect(
      (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res),
    ).rejects.toThrow('column c.company_id does not exist');

    expect(res.statusCode).toBe(0);
  });

  it('rethrows plain errors with no pg error code', async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('to_regclass')) return LEDGER_EXISTS_ROW;
      throw new Error('connection terminated unexpectedly');
    });

    const { req, res } = mockReqRes();
    await expect(
      (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res),
    ).rejects.toThrow('connection terminated unexpectedly');
  });
});
