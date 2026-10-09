/**
 * adminFailureAudit's target_id: a uuid that is a whole DECODED path segment — never one from the query string
 * (brk-nrfb LOW-1) or found anywhere in the raw path (sec-nrfb LOW-1).
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
  it('is the uuid that is a whole path segment', async () => {
    await auditFailedAdminRequest(req(`/api/admin/users/${VICTIM}/impersonate`, { id: VICTIM }), 'admin', 500, 'threw');
    expect(targetOf()).toBe(VICTIM);
  });

  it('is the DECODED segment when a character of the id is percent-encoded', async () => {
    const encoded = `/api/admin/users/${OTHER.slice(0, 35)}%${OTHER.charCodeAt(35).toString(16)}/x`;
    await auditFailedAdminRequest(req(encoded, { id: OTHER }), 'admin', 500, 'threw');
    expect(targetOf()).toBe(OTHER);
  });

  it('is null for a segment that only contains a uuid (a suffix)', async () => {
    await auditFailedAdminRequest(req(`/api/admin/users/${VICTIM}zzz/reset-password`, { id: `${VICTIM}zzz` }), 'admin', 500, 'threw');
    expect(targetOf()).toBeNull();
  });

  // brk-nrfb LOW-1: Next puts the query string ahead of the route params in req.query.
  it('ignores a uuid in the query string', async () => {
    await auditFailedAdminRequest(req(`/api/admin/users/${VICTIM}/reset-password?ref=${OTHER}`, { ref: OTHER, id: VICTIM }),
      'admin', 500, 'threw');
    expect(targetOf()).toBe(VICTIM);
    query.mockReset(); query.mockResolvedValue({ rows: [] });
    await auditFailedAdminRequest(req(`/api/admin/alert-settings?ref=${OTHER}`, { ref: OTHER }), 'admin', 500, 'threw');
    expect(targetOf()).toBeNull();
  });

  it('is null with no uuid segment, and GET is not recorded', async () => {
    await auditFailedAdminRequest(req('/api/admin/plans', {}), 'admin', 500, 'rolled_back');
    expect(targetOf()).toBeNull();
    query.mockReset();
    await auditFailedAdminRequest(req('/api/admin/plans', {}, 'GET'), 'admin', 500, 'rolled_back');
    expect(query).not.toHaveBeenCalled();
  });

  it("writes on the caller's connection when one is given, else on the pool", async () => {
    const own = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await auditFailedAdminRequest(req('/api/admin/plans', {}), 'admin', 500, 'rolled_back', own);
    expect(own.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  // rev-nrfb-blind round 2 LOW-2: ip_address is varchar(45); a request with no socket records NULL.
  it('the client IP is cut to the column, and a request without a socket records NULL', async () => {
    const long = { method: 'POST', url: '/api/admin/plans', query: {}, socket: { remoteAddress: '10.0.0.1' },
      headers: { 'x-forwarded-for': `${'f'.repeat(60)}` } } as unknown as NextApiRequest;
    await auditFailedAdminRequest(long, 'admin', 500, 'threw');
    expect(query.mock.calls[0]![1][3]).toHaveLength(45);
    query.mockReset(); query.mockResolvedValue({ rows: [] });
    await auditFailedAdminRequest({ method: 'POST', url: '/api/admin/plans', query: {}, headers: {} } as unknown as NextApiRequest,
      'admin', 500, 'threw');
    expect(query.mock.calls[0]![1][3]).toBeNull();
  });
});
