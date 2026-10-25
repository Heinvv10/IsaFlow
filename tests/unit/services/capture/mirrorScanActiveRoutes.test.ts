/**
 * S-07e part B, review round 7: while a scan of a connection holds its claim (a scan-now's, whose scan-log INSERT holds
 * a key-share lock on the row, or the cron's), the connection's DELETE, PATCH and disconnect routes answer 409 before
 * any database call. Otherwise each queued on the route write pool and the row, holding an auth-pool connection, and a
 * tenant's burst of them stalled every tenant's requests. Both mirrors; auth wrappers are pass-through, services fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const m = vi.hoisted(() => ({
  update: vi.fn(), remove: vi.fn(), disconnect: vi.fn(), updateSent: vi.fn(), removeSent: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/capture/mirrorConnectionService', () => ({
  updateConnectionSenders: m.update, deleteConnection: m.remove, disconnectConnection: m.disconnect,
}));
vi.mock('@/modules/accounting/services/ar/sentMirrorAdmin', () => ({
  updateSentConnection: m.updateSent, deleteSentConnection: m.removeSent,
}));

import captureRoute from '../../../../pages/api/accounting/capture/mirror/[id]/index';
import disconnectRoute from '../../../../pages/api/accounting/capture/mirror/[id]/disconnect';
import sentRoute from '../../../../pages/api/accounting/ar/sent-mirror/connections/[id]/index';
import { claimScan } from '@/modules/accounting/services/capture/mirrorScanActive';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Out { status: number; json: { error?: { details?: { reason?: string } } } | null }
async function call(route: unknown, method: string, id: string, body: unknown = {}): Promise<Out> {
  const out: Out = { status: 0, json: null };
  const res = { status(code: number) { out.status = code; return this; }, json(j: Out['json']) { out.json = j; return this; } };
  await (route as (rq: unknown, rs: NextApiResponse) => Promise<unknown>)({ method, companyId: COMPANY, query: { id }, body }, res as unknown as NextApiResponse);
  return out;
}

beforeEach(() => {
  vi.resetAllMocks();
});

const CASES = [
  ['capture mirror DELETE', captureRoute, 'DELETE', () => m.remove, { deleted: true }],
  ['capture mirror PATCH', captureRoute, 'PATCH', () => m.update, { connection: {} }],
  ['capture mirror disconnect', disconnectRoute, 'POST', () => m.disconnect, true],
  ['sent mirror DELETE', sentRoute, 'DELETE', () => m.removeSent, { deleted: true }],
  ['sent mirror PATCH', sentRoute, 'PATCH', () => m.updateSent, { connection: {} }],
] as const;

describe.each(CASES)('%s', (_name, route, method, service, serviceResult) => {
  it('answers 409 while a scan of that connection runs, calling no service', async () => {
    const release = claimScan(A);
    expect(release).not.toBeNull();
    try {
      const r = await call(route, method, A);
      expect(r.status).toBe(409);
      expect(r.json?.error?.details?.reason).toBe('scan');
      expect(service()).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it('proceeds once the scan is over, and while a scan of ANOTHER connection runs', async () => {
    service().mockResolvedValue(serviceResult);
    const other = claimScan(B);
    try {
      expect((await call(route, method, A)).status).toBe(200);
    } finally {
      other?.();
    }
    expect(service()).toHaveBeenCalledTimes(1);
  });
});
