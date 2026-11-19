/**
 * Intercompany P2: the receiver's transaction opens on the REQUEST pool's login (getAuthPool: isaflow_app in production), never the
 * service pool's (getPool: isaflow_service, which inherits app_service, whose policies are USING (true)); a RESET ROLE inside the
 * transaction on the service login would read every tenant. The integration suite mirror-worker-logins proves the behaviour on the real
 * logins; this pins the wiring and the session settings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const client = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), release: vi.fn() };
  return { client, auth: vi.fn(async () => client), service: vi.fn(async () => client) };
});
vi.mock('@/lib/auth/authPool', () => ({ getAuthPool: () => ({ connect: m.auth }) }));
vi.mock('@/lib/neon', () => ({ getPool: () => ({ connect: m.service }) }));

import { withReceiverTx } from '@/modules/accounting/services/intercompany/receiverTx';

beforeEach(() => { vi.clearAllMocks(); });

describe('withReceiverTx', () => {
  it('connects on the request pool, never the service pool, as app_user with the receiver\'s claims and company', async () => {
    await withReceiverTx({ userId: 'user-b', companyId: 'co-b' }, async () => 'done');
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.service).not.toHaveBeenCalled();
    const sqlSent = m.client.query.mock.calls.map((c) => String(c[0]));
    expect(sqlSent[0]).toBe('BEGIN');
    expect(sqlSent).toContain('SET LOCAL ROLE app_user');
    const claims = m.client.query.mock.calls.find((c) => String(c[0]).includes('request.jwt.claims'))!;
    expect(JSON.parse(String((claims[1] as string[])[0]))).toEqual({ sub: 'user-b' });
    const company = m.client.query.mock.calls.find((c) => String(c[0]).includes('app.current_company_id'))!;
    expect((company[1] as string[])[0]).toBe('co-b');
    expect(sqlSent.at(-1)).toBe('COMMIT');
    expect(m.client.release).toHaveBeenCalled();
  });

  it('rolls back, and releases the connection, when the work throws', async () => {
    await expect(withReceiverTx({ userId: 'u', companyId: 'c' }, async () => { throw new Error('no'); })).rejects.toThrow('no');
    expect(m.client.query.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
    expect(m.client.release).toHaveBeenCalled();
  });
});
