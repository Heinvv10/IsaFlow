/**
 * Pentest finding #12 (LOW, no batch cap): POST /api/accounting/customers-bulk
 * validates `ids: string[]` for UUID format + non-empty but had no max-length,
 * unlike supplier-invoices-bulk-action.ts (.max(200)) and
 * statement-bulk-email.ts (MAX_BATCH_SIZE = 100). Pin the new cap (200) and
 * confirm a within-cap request still reaches the DB layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));

vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (fn: unknown) => fn,
}));

vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (fn: unknown) => fn,
}));

vi.mock('@/lib/cache', () => ({
  cache: { invalidate: vi.fn() },
}));

vi.mock('@/lib/cache-keys', () => ({
  CACHE_KEYS: { customers: (companyId: string) => `customers:${companyId}` },
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ success: true, data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ success: false, error })),
    methodNotAllowed: vi.fn(() => ({ success: false, error: 'method not allowed' })),
    internalError: vi.fn((_res: unknown, _err: unknown, error: string) => ({ success: false, error })),
  },
}));

const sqlMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
}));

import handler from '../../../pages/api/accounting/customers-bulk';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
// v4 UUID shape — the handler's own regex only checks the dashed hex shape.
const ID_A = '11111111-1111-4111-8111-111111111111';

function req(body: unknown): NextApiRequest {
  return {
    method: 'POST',
    body,
    companyId: COMPANY_ID,
  } as unknown as NextApiRequest;
}

function res(): NextApiResponse {
  return {} as NextApiResponse;
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

describe('customers-bulk batch cap', () => {
  beforeEach(() => {
    sqlMock.mockClear();
    sqlMock.mockResolvedValue([]);
  });

  it('rejects an ids array over the 200-item cap', async () => {
    const ids = Array.from({ length: 201 }, () => ID_A);
    const result = await (handler as Handler)(req({ ids, action: 'activate' }), res());
    expect((result as { success: boolean }).success).toBe(false);
    // Must reject before touching the DB.
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('accepts an ids array exactly at the 200-item cap', async () => {
    const ids = Array.from({ length: 200 }, () => ID_A);
    const result = await (handler as Handler)(req({ ids, action: 'activate' }), res());
    expect((result as { success: boolean }).success).toBe(true);
    expect(sqlMock).toHaveBeenCalled();
  });
});
