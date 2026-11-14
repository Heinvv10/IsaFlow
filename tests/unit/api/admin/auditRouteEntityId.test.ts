/**
 * Audit 4.7: a user's Audit tab asks /api/admin/audit?entity_type=user&entity_id=<id>. The route must hand
 * entity_id to the query (it used to drop it, so the tab listed every admin action on the platform). The SQL
 * side is pinned in tests/integration/admin-screens-wp13.int.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const getUnifiedAuditLog = vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 20, total_pages: 0 }));
vi.mock('@/modules/admin/services/auditService', () => ({
  getUnifiedAuditLog: (...a: unknown[]) => getUnifiedAuditLog(...(a as [])),
}));

import route from '../../../../pages/api/admin/audit';

describe('GET /api/admin/audit', () => {
  it('passes entity_id through to the audit query', async () => {
    const req = { method: 'GET', query: { entity_type: 'user', entity_id: 'user-42', limit: '20' }, headers: {} } as unknown as NextApiRequest;
    const res = { status() { return res; }, json() { return res; }, setHeader() { return res; } } as unknown as NextApiResponse;
    await (route as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);
    expect(getUnifiedAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entity_type: 'user', entity_id: 'user-42', limit: 20 }));
  });
});
