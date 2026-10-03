/**
 * D11 round 3 (blind review LOWs): route-level pins for capture/[id]/post-expense (the duplicate guard's answer goes
 * through `respondReceiptDuplicate`: busy 503, real duplicate 409) and ai-invoice-pipeline (the capture event lock is
 * taken with the document lock, and a held event lock answers 503).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]) }));
vi.mock('@/modules/accounting/services/capture/captureRowLock', async (orig) => ({
  ...(await orig<object>()),
  lockCaptureEventForPosting: vi.fn(), lockCapturedDocumentForUpdate: vi.fn(), lockPostableCaptureEventIds: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/captureExpenseAccount', () => ({ resolveCaptureExpenseAccount: vi.fn().mockResolvedValue('acct') }));
vi.mock('@/modules/accounting/services/gl/documentLineAccountGuard', async (orig) => ({
  ...(await orig<object>()), documentLineAccountRefusal: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccountId: vi.fn().mockResolvedValue('a') }));
vi.mock('@/modules/accounting/services/capture/receiptDuplicateGuard', () => ({ checkReceiptDuplicate: vi.fn() }));

import { lockCaptureEventForPosting, lockCapturedDocumentForUpdate, lockPostableCaptureEventIds } from '@/modules/accounting/services/capture/captureRowLock';
import { checkReceiptDuplicate } from '@/modules/accounting/services/capture/receiptDuplicateGuard';
import { CaptureEventLockedError } from '@/modules/accounting/services/capture/captureEventLock';
import postExpense from '../../../pages/api/accounting/capture/[id]/post-expense';
import pipeline from '../../../pages/api/accounting/ai-invoice-pipeline';

const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
function call(handler: Handler, body: unknown, query: Record<string, string> = {}) {
  const req = { method: 'POST', query, body, headers: {}, socket: {}, companyId: 'c', user: { id: 'u' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, send(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
type R = Awaited<ReturnType<typeof call>>;
const held = (r: R) => { expect(r.statusCode, JSON.stringify(r.sent)).toBe(503); expect(r.headers['Retry-After']).toBe('2'); };
const dup = (kind: 'duplicate' | 'busy') => ({ kind, message: 'm', details: { code: 'X' } });

beforeEach(() => { vi.clearAllMocks(); });

describe('capture/[id]/post-expense: the duplicate guard', () => {
  beforeEach(() => {
    vi.mocked(lockCaptureEventForPosting).mockResolvedValue({
      eventStatus: 'extracted', documentId: ID, documentStatus: 'pending', documentPostedAt: null,
      extractedData: { vendorName: 'v' },
    } as never);
  });
  it('busy -> 503 + Retry-After', async () => {
    vi.mocked(checkReceiptDuplicate).mockResolvedValueOnce(dup('busy') as never);
    held(await call(postExpense, {}, { id: ID }));
  });
  it('a real duplicate -> 409, no Retry-After', async () => {
    vi.mocked(checkReceiptDuplicate).mockResolvedValueOnce(dup('duplicate') as never);
    const r = await call(postExpense, {}, { id: ID });
    expect(r.statusCode).toBe(409); expect(r.headers['Retry-After']).toBeUndefined();
  });
});

describe('ai-invoice-pipeline: the document and event locks', () => {
  it('takes the capture event lock for the document it locked', async () => {
    vi.mocked(lockCapturedDocumentForUpdate).mockResolvedValueOnce({ status: 'posted', posted_at: 'x' } as never);
    vi.mocked(lockPostableCaptureEventIds).mockResolvedValueOnce([]);
    await call(pipeline, { documentId: ID });
    expect(lockPostableCaptureEventIds).toHaveBeenCalledWith('c', ID);
  });
  it('a held capture event lock -> 503 + Retry-After', async () => {
    vi.mocked(lockCapturedDocumentForUpdate).mockResolvedValueOnce({ status: 'pending' } as never);
    vi.mocked(lockPostableCaptureEventIds).mockRejectedValueOnce(new CaptureEventLockedError('e'));
    held(await call(pipeline, { documentId: ID }));
  });
  it('a missing document keeps 404 and takes no event lock', async () => {
    vi.mocked(lockCapturedDocumentForUpdate).mockResolvedValueOnce(null as never);
    const r = await call(pipeline, { documentId: ID });
    expect(r.statusCode).toBe(404);
    expect(lockPostableCaptureEventIds).not.toHaveBeenCalled();
  });
});
