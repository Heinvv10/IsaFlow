/**
 * GET /api/accounting/bank-import-batches (WP1 PR-A; the UUID check is WP7's): a bad bankAccountId is a 400 before
 * any read, the list comes from listImportBatches ordered by statement date, and a failed read is a 500 — not the
 * `{ batches: [] }` it used to answer, which the statement widget showed as "No statement imports found".
 *
 * The real withErrorHandler turns the throw into the 500; auth is mocked to a pass-through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const listImportBatches = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankImportBatchQueryService', () => ({
  listImportBatches: (...a: unknown[]) => listImportBatches(...a),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => { throw new Error('the route must not query directly'); }) }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/bank-import-batches';

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001';
const BANK = 'bbbbbbbb-0000-4000-8000-000000000002';

function call(query: Record<string, string>, method = 'GET') {
  const req = { method, query, url: '/api/accounting/bank-import-batches', headers: {}, companyId: COMPANY } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, body: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    end(payload?: unknown) { this.body = payload; return this; },
  };
  return (handler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>)(req, res as unknown as NextApiResponse)
    .then(() => res);
}

// A block body: mockReset() returns the mock, and a function returned from beforeEach runs as a cleanup hook.
beforeEach(() => { listImportBatches.mockReset(); });

describe('GET /api/accounting/bank-import-batches', () => {
  it('a bankAccountId that is not a UUID is a 400, and nothing is read', async () => {
    for (const bad of ['not-a-uuid', "x' OR 1=1 --", '']) {
      const res = await call({ bankAccountId: bad });
      expect(res.statusCode, bad).toBe(400);
    }
    expect((await call({})).statusCode).toBe(400);
    expect(listImportBatches).not.toHaveBeenCalled();
  });

  it('delegates to listImportBatches for the company, ordered by statement date, and returns { batches } unchanged', async () => {
    const batches = [{ id: 'b1', statementDate: '2026-09-30', transactionsRemaining: 3 }];
    listImportBatches.mockResolvedValue(batches);
    const res = await call({ bankAccountId: BANK });
    expect(res.statusCode).toBe(200);
    expect(listImportBatches).toHaveBeenCalledWith(COMPANY, { bankAccountId: BANK, order: 'statement_date' });
    expect((res.body as { data: unknown }).data).toEqual({ batches });
  });

  it('a failed read is a 500, not an empty list', async () => {
    listImportBatches.mockRejectedValue(new Error('connection terminated'));
    const res = await call({ bankAccountId: BANK });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('"batches"');
  });

  it('only GET', async () => {
    expect((await call({ bankAccountId: BANK }, 'POST')).statusCode).toBe(405);
    expect(listImportBatches).not.toHaveBeenCalled();
  });
});
