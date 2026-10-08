/**
 * adminFailureAudit's target_id (sec-nrfb LOW-1): the route's decoded uuid param, a whole value only — never a uuid
 * found anywhere in the raw path, which percent-encoding or a suffix could point at another user.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({ getPlatformAdminPool: () => ({ query }) }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { auditFailedAdminRequest } from '@/lib/auth/adminFailureAudit';

const VICTIM = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const req = (url: string, q: Record<string, unknown>, method = 'POST') =>
  ({ method, url, query: q, headers: {}, socket: { remoteAddress: '10.0.0.1' } }) as unknown as NextApiRequest;
const targetOf = () => query.mock.calls[0]![1][1];

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

describe('the failure row target', () => {
  it("is the route's decoded uuid param", async () => {
    await auditFailedAdminRequest(req(`/api/admin/users/${VICTIM}/impersonate`, { id: VICTIM }), 'admin', 500, 'threw');
    expect(targetOf()).toBe(VICTIM);
  });

  it('is not a uuid read out of the raw path (percent-encoded id: the decoded param wins)', async () => {
    const encoded = `/api/admin/users/${OTHER.slice(0, 35)}%${OTHER.charCodeAt(35).toString(16)}/x`;
    await auditFailedAdminRequest(req(encoded, { id: OTHER }), 'admin', 500, 'threw');
    expect(targetOf()).toBe(OTHER);
  });

  it('is null for a param that only contains a uuid (a suffix)', async () => {
    await auditFailedAdminRequest(req(`/api/admin/users/${VICTIM}zzz/reset-password`, { id: `${VICTIM}zzz` }), 'admin', 500, 'threw');
    expect(targetOf()).toBeNull();
  });

  it('is null with no uuid param, and GET is not recorded', async () => {
    await auditFailedAdminRequest(req('/api/admin/plans', {}), 'admin', 500, 'rolled_back');
    expect(targetOf()).toBeNull();
    query.mockReset();
    await auditFailedAdminRequest(req('/api/admin/plans', {}, 'GET'), 'admin', 500, 'rolled_back');
    expect(query).not.toHaveBeenCalled();
  });
});
