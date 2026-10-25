/**
 * S-07e part B, review round 6: a scan-now runs inside a request, so it holds that request's
 * auth-pool connection for as long as the scan runs. Both scan-now routes therefore refuse
 * (409, before any scan starts) a connection that already has a scan running and a second
 * scan-now for a company that already has one, and run the scan under the 30 s scan-now
 * deadline instead of the cron's 120 s. Auth wrappers are pass-through here; the services are
 * fakes whose scan stays open until the test lets it finish.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const m = vi.hoisted(() => ({
  getImap: vi.fn(), scanImap: vi.fn(), getSent: vi.fn(), scanSent: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/capture/imapMirrorService', () => ({ getConnection: m.getImap, scanConnection: m.scanImap }));
vi.mock('@/modules/accounting/services/ar/sentMirrorService', () => ({ getSentConnection: m.getSent, scanSentConnection: m.scanSent }));

import captureRoute from '../../../../pages/api/accounting/capture/mirror/[id]/scan-now';
import sentRoute from '../../../../pages/api/accounting/ar/sent-mirror/connections/[id]/scan-now';
import { claimScan } from '@/modules/accounting/services/capture/mirrorScanActive';
import { MIRROR_SCAN_DEADLINE_MS } from '@/modules/accounting/services/capture/mirrorScanGuard';
import { SCAN_NOW_DEADLINE_MS } from '@/modules/accounting/services/capture/mirrorScanNow';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '99999999-9999-4999-8999-999999999999';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Out { status: number; json: { data?: unknown; error?: { message?: string; details?: { reason?: string } } } | null }
async function post(route: unknown, id: string, companyId = COMPANY): Promise<Out> {
  const out: Out = { status: 0, json: null };
  const res = { status(code: number) { out.status = code; return this; }, json(j: Out['json']) { out.json = j; return this; } };
  await (route as (rq: unknown, rs: NextApiResponse) => Promise<unknown>)({ method: 'POST', companyId, query: { id } }, res as unknown as NextApiResponse);
  return out;
}

/** A scan that stays open until `finish()`. */
function openScan() {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { finish, run: async () => { await done; return { scanned: 1, errors: 0 }; } };
}

const SERVICES = [
  ['capture mirror', captureRoute, () => m.getImap, () => m.scanImap],
  ['sent mirror', sentRoute, () => m.getSent, () => m.scanSent],
] as const;

beforeEach(() => {
  vi.resetAllMocks();
});

describe.each(SERVICES)('POST scan-now, %s', (_name, route, getter, scanner) => {
  const connection = (id: string, companyId = COMPANY) => ({ id, companyId });

  it('runs the scan under the scan-now deadline, which is shorter than the cron\'s', async () => {
    getter().mockResolvedValue(connection(A));
    scanner().mockResolvedValue({ scanned: 0, errors: 0 });
    const r = await post(route, A);
    expect(r.status).toBe(200);
    expect(scanner()).toHaveBeenCalledWith(connection(A), { deadlineMs: SCAN_NOW_DEADLINE_MS });
    expect(SCAN_NOW_DEADLINE_MS).toBe(30_000);
    expect(SCAN_NOW_DEADLINE_MS).toBeLessThan(MIRROR_SCAN_DEADLINE_MS);
  });

  it('answers 409 to a second scan-now for the company while one is running, starts no second scan, and allows one after it', async () => {
    const first = openScan();
    getter().mockImplementation(async (id: string) => connection(id));
    scanner().mockImplementationOnce(first.run);
    const running = post(route, A);
    await vi.waitFor(() => expect(scanner()).toHaveBeenCalledTimes(1));

    const second = await post(route, B);
    expect(second.status).toBe(409);
    expect(second.json?.error?.details?.reason).toBe('company');
    expect(scanner()).toHaveBeenCalledTimes(1);

    first.finish();
    expect((await running).status).toBe(200);
    scanner().mockResolvedValue({ scanned: 0, errors: 0 });
    expect((await post(route, B)).status).toBe(200);
  });

  it('does not hold one company\'s scan-now against another company', async () => {
    const first = openScan();
    getter().mockImplementation(async (id: string, companyId: string) => connection(id, companyId));
    scanner().mockImplementationOnce(first.run).mockResolvedValue({ scanned: 0, errors: 0 });
    const running = post(route, A);
    await vi.waitFor(() => expect(scanner()).toHaveBeenCalledTimes(1));
    expect((await post(route, B, OTHER_COMPANY)).status).toBe(200);
    first.finish();
    await running;
  });

  it('answers 409 for a connection that already has a scan running (the cron\'s, or another request\'s) and starts none', async () => {
    getter().mockResolvedValue(connection(A));
    const release = claimScan(A);
    expect(release).not.toBeNull();
    try {
      const r = await post(route, A);
      expect(r.status).toBe(409);
      expect(r.json?.error?.details?.reason).toBe('connection');
      expect(scanner()).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
    scanner().mockResolvedValue({ scanned: 0, errors: 0 });
    expect((await post(route, A)).status).toBe(200);
  });

  it('a scan that throws still frees the company', async () => {
    getter().mockResolvedValue(connection(A));
    scanner().mockRejectedValueOnce(new Error('pool is closed')).mockResolvedValue({ scanned: 0, errors: 0 });
    await expect(post(route, A)).rejects.toThrow('pool is closed');
    expect((await post(route, A)).status).toBe(200);
  });
});
