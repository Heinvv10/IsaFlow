/**
 * Unlinking a captured document takes the document row with the posting paths' lock (captureRowLock, 5 s). Held past
 * that, the route answers 503 with Retry-After through respondIfLockTimeout, so withAuth rolls back; any other failure
 * still reaches the error handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const unlink = vi.fn();
vi.mock('@/modules/accounting/services/capture/capturedAttachmentLinks', () => ({
  listBankLineAttachments: vi.fn(), unlinkCapturedDocFromBankTx: (...a: unknown[]) => unlink(...a),
}));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: (t: string) => t }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/bank-tx-attachments';
import { CaptureRowLockTimeoutError } from '@/modules/accounting/services/capture/captureRowLock';

const DOC = '22222222-2222-4222-8222-222222222222';
const TX = '33333333-3333-4333-8333-333333333333';
async function del() {
  const out = { code: 0, body: undefined as unknown, headers: {} as Record<string, unknown> };
  const res = {
    status(c: number) { out.code = c; return this; },
    setHeader(k: string, v: unknown) { out.headers[k.toLowerCase()] = v; return this; },
    json(b: unknown) { out.body = b; return this; },
    send(b: unknown) { out.body = b; return this; },
    end() { return this; },
  };
  await (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(
    { method: 'DELETE', companyId: 'co-1', query: { documentId: DOC, bankTransactionId: TX } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return out;
}

beforeEach(() => { unlink.mockReset(); });

describe('DELETE bank-tx-attachments?documentId= (unlink)', () => {
  it('answers 503 with Retry-After when the document row is held past the lock bound', async () => {
    unlink.mockRejectedValue(new CaptureRowLockTimeoutError(DOC));
    const r = await del();
    expect(r.code).toBe(503);
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('lets any other failure reach the error handler', async () => {
    unlink.mockRejectedValue(new Error('boom'));
    await expect(del()).rejects.toThrow('boom');
  });

  it('unlinks with the company, document and line it was given', async () => {
    unlink.mockResolvedValue('unlinked');
    const r = await del();
    expect(unlink).toHaveBeenCalledWith('co-1', DOC, TX);
    expect(r.code).toBe(200);
  });
});
