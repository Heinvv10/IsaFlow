/**
 * AP-01: the send's timeout covers the WHOLE exchange. fetchWithTimeout cleared its timer once headers arrived, so a
 * stalled response body was unbounded and a send could outlast SEND_WINDOW_MS (when an operator may release a pending
 * claim). A body that stalls is an unknown outcome - never a rejection (it may have been accepted), never a hang.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/modules/accounting/services/ap/netcashTimeouts', () => ({ REQUEST_TIMEOUT_MS: 100, SEND_WINDOW_MS: 120_000 }));

import { getSubmissionStatus, submitEftBatch, type NetcashPayment } from '@/modules/accounting/services/ap/netcashService';

const PAYMENTS: NetcashPayment[] = [
  { accountHolder: 'Acme', bankCode: '250655', accountNumber: '62000000001', amount: 115000, reference: 'R1' },
];

/** Headers arrive at once; the body never ends until the request is aborted (as a real fetch does on abort). */
function stalledBody(status: number, init: RequestInit | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')));
    },
  });
  return new Response(body, { status });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('submitEftBatch: a stalled response body', () => {
  it.each([200, 400, 500])('headers %i then a stalled body: unknown within the timeout, never a hang or a rejection', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => stalledBody(status, init)));
    const started = Date.now();
    const result = await submitEftBatch('service-key', 'payouts-key', PAYMENTS);
    expect(result).toMatchObject({ success: false, outcome: 'unknown' });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 5000);
});

describe('getSubmissionStatus: a stalled response body', () => {
  it.each([200, 500])('headers %i then a stalled body: status unknown within the timeout, never a hang', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => stalledBody(status, init)));
    const started = Date.now();
    const result = await getSubmissionStatus('service-key', 'NC-REF');
    expect(result.status).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(3000);
  }, 5000);
});
