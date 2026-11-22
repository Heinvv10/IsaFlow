/** Codex gate on PR #1703: the supplier POs report route refuses a retired status it cannot map, before any query; sent still works. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql, default: sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (handler: unknown) => handler }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));

import handler from '../../../pages/api/accounting/reports-supplier-pos';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as
    NextApiResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}
const get = async (status: string) => {
  const res = response();
  await handler({ method: 'GET', companyId: 'c1', query: { status } } as unknown as NextApiRequest, res);
  return res;
};

beforeEach(() => { vi.clearAllMocks(); sql.mockResolvedValue([]); });

describe('reports-supplier-pos status filter', () => {
  it.each(['partially_invoiced', 'invoiced', 'shipped'])('%s: 400 naming the canonical statuses, no query', async (status) => {
    const res = await get(status);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(res.json.mock.calls[0]![0])).toContain('draft, submitted, approved, partially_received, received, closed, cancelled');
    expect(sql).not.toHaveBeenCalled();
  });
  it('sent reads approved', async () => {
    const res = await get('sent');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(sql.mock.calls[0]!.slice(1)).toContain('approved');
  });
});
