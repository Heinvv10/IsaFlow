/**
 * NUMRACE register (m): the products POST had `body.code || generateProductCode(cat, 0)`, a fallback that
 * could never run (validateProduct refuses a missing or blank code) and would have minted the same
 * '<PFX>-0001' for every product if it had. It is gone: a body without a code is refused before any query,
 * and the code a body carries is the code stored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));

import handler from '../../../pages/api/accounting/products';

const companyId = '10000000-0000-4000-8000-000000000001';
const product = { name: 'Widget', costPrice: 1, sellingPrice: 2, reorderLevel: 0 };

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as
    NextApiResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}
const post = (body: Record<string, unknown>) => {
  const res = response();
  return handler({ method: 'POST', companyId, user: { id: 'u1' }, body } as unknown as NextApiRequest, res)
    .then(() => res);
};
// The values bound into the INSERT (sql is a tagged template: [strings, ...values]).
const insertValues = () => sql.mock.calls.find(([strings]) =>
  (strings as string[]).join('?').includes('INSERT INTO products'))?.slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  sql.mockResolvedValue([{ id: 'p1' }]);
});

describe('products POST: the code comes from the body, never generated', () => {
  it.each([[{}], [{ code: '' }], [{ code: '   ' }]])('refuses %j before any query', async (extra) => {
    const res = await post({ ...product, ...extra });
    expect(res.status).toHaveBeenCalledWith(expect.any(Number));
    const status = res.status.mock.calls[0]![0] as number;
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(JSON.stringify(res.json.mock.calls)).toMatch(/Product code is required/);
    expect(sql).not.toHaveBeenCalled();
  });

  it('stores the code the body carries', async () => {
    const res = await post({ ...product, code: 'WID-77', category: 'widgets' });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(insertValues()).toBeDefined();
    expect(insertValues()![1]).toBe('WID-77');
  });
});
