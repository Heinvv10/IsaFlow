/**
 * D11, the capture routes the first census missed: a lock a peer holds past the bounded wait answers 503 + Retry-After.
 *   capture/[id]/discard   CaptureEventLockedError (was 409)
 *   expense-claims POST    ClaimSourceDocumentError 'busy' (the R-088 content fence, was 409)
 *   the posting claim's `content_busy` refusal, through `respondCapturedDocumentRefusal` (was 409)
 * A refusal about the document's state keeps its status: already posted 400, the same file posted elsewhere 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureEventLock', async (orig) => ({
  ...(await orig<object>()), lockCaptureEventRow: vi.fn(),
}));
vi.mock('@/modules/accounting/services/expense/expenseClaimService', async (orig) => ({
  ...(await orig<object>()), createClaim: vi.fn(),
}));

import { lockCaptureEventRow, CaptureEventLockedError } from '@/modules/accounting/services/capture/captureEventLock';
import { createClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { ClaimSourceDocumentError } from '@/modules/accounting/services/expense/claimSourceDocuments';
import { respondCapturedDocumentRefusal } from '@/modules/accounting/services/capture/capturePostingClaim';
import discard from '../../../pages/api/accounting/capture/[id]/discard';
import expenseClaims from '../../../pages/api/accounting/expense-claims/index';

const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function makeRes() {
  return {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
}
function call(handler: Handler, body: unknown, query: Record<string, string> = {}) {
  const req = { method: 'POST', query, body, companyId: '11111111-1111-4111-8111-111111111111',
    user: { id: '99999999-9999-4999-8999-999999999999' } } as unknown as NextApiRequest;
  const res = makeRes();
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
function expectHeld(res: ReturnType<typeof makeRes>) {
  expect(res.statusCode).toBe(503);
  expect(res.headers['Retry-After']).toBe('2');
}

beforeEach(() => { vi.clearAllMocks(); });

describe('D11 capture/[id]/discard', () => {
  it('a held capture event -> 503 + Retry-After (was 409)', async () => {
    vi.mocked(lockCaptureEventRow).mockRejectedValueOnce(new CaptureEventLockedError(ID));
    expectHeld(await call(discard, {}, { id: ID }));
  });
  it('an already-posted event keeps its 400', async () => {
    vi.mocked(lockCaptureEventRow).mockResolvedValueOnce({ status: 'posted' } as never);
    const res = await call(discard, {}, { id: ID });
    expect(res.statusCode).toBe(400);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});

describe('D11 expense-claims: the content fence', () => {
  const body = { employeeId: ID, lines: [] };
  it("a fingerprint a peer holds ('busy') -> 503 + Retry-After (was 409)", async () => {
    vi.mocked(createClaim).mockRejectedValueOnce(new ClaimSourceDocumentError('busy', ID));
    expectHeld(await call(expenseClaims, body));
  });
  it('an already-posted source document keeps its 400', async () => {
    vi.mocked(createClaim).mockRejectedValueOnce(new ClaimSourceDocumentError('already_posted', ID));
    const res = await call(expenseClaims, body);
    expect(res.statusCode).toBe(400);
    expect(res.headers['Retry-After']).toBeUndefined();
  });
});

describe('D11 respondCapturedDocumentRefusal (capture post, post-expense, receipt-to-journal, ai-invoice-pipeline)', () => {
  const answer = (refusal: Parameters<typeof respondCapturedDocumentRefusal>[1]) => {
    const res = makeRes();
    respondCapturedDocumentRefusal(res as unknown as NextApiResponse, refusal);
    return res;
  };
  it('content_busy (a lock a peer still holds) -> 503 + Retry-After', () => expectHeld(answer('content_busy')));
  it('already_posted keeps 400; content_posted keeps 409', () => {
    expect(answer('already_posted').statusCode).toBe(400);
    expect(answer('content_posted').statusCode).toBe(409);
    expect(answer('content_posted').headers['Retry-After']).toBeUndefined();
  });
});
