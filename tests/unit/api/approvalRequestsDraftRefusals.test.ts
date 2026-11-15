/**
 * POST /api/accounting/approval-requests action=request, the two answers a credit-note raise can now get from the
 * row lock it takes (approvalDocuments.raiseOnce):
 *  - the note is no longer a draft (posted or cancelled before the raise took its row): 409 reason DOCUMENT_NOT_DRAFT,
 *    not the route's 500;
 *  - the note's row is held past the 5s budget (a cancel or approve in flight): 503 + Retry-After, which rolls the
 *    request back, not a 500 and not a 4xx that would commit an aborted transaction.
 * Real route and real error classes; only requestApproval is scripted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/gl/approvalService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/approvalService')>()),
  requestApproval: vi.fn(),
}));

import { requestApproval } from '@/modules/accounting/services/gl/approvalService';
import { ApprovalDocumentNotDraftError } from '@/modules/accounting/services/gl/approvalDocumentErrors';
import { CreditNoteLockTimeoutError } from '@/modules/accounting/services/ar/creditNoteLock';
import handler from '../../../pages/api/accounting/approval-requests';

const NOTE = '22222222-2222-4222-8222-222222222222';

function post(body: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; return this; },
  };
  const req = { method: 'POST', body, query: {}, headers: {}, user: { id: '33333333-3333-4333-8333-333333333333' }, companyId: 'c' };
  return (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req as never, res as never)
    .then(() => ({ res, headers }));
}
const raise = (documentType: string) => post({ action: 'request', documentType, documentId: NOTE });

beforeEach(() => { vi.mocked(requestApproval).mockReset(); });

describe.each(['supplier_credit_note', 'customer_credit_note', 'credit_note'])('request on a %s', (documentType) => {
  it('a note that is no longer a draft is a 409 DOCUMENT_NOT_DRAFT carrying the refusal text', async () => {
    vi.mocked(requestApproval).mockRejectedValue(new ApprovalDocumentNotDraftError(documentType, NOTE, 'cancelled'));
    const { res } = await raise(documentType);
    expect(res.statusCode).toBe(409);
    const body = res.body as { error: { message: string; details?: { reason?: string } } };
    expect(body.error.message).toContain('is cancelled, not a draft');
    expect(body.error.details?.reason).toBe('DOCUMENT_NOT_DRAFT');
  });

  it('a note row held past the budget is a 503 with Retry-After, never a 4xx or a 500', async () => {
    vi.mocked(requestApproval).mockRejectedValue(new CreditNoteLockTimeoutError(NOTE));
    const { res, headers } = await raise(documentType);
    expect(res.statusCode).toBe(503);
    expect(headers['retry-after']).toBeDefined();
    expect(JSON.stringify(res.body)).toContain('retry in a moment');
  });
});

it('any other failure is still rethrown (no blanket catch swallowed it)', async () => {
  vi.mocked(requestApproval).mockRejectedValue(new Error('db down'));
  await expect(raise('supplier_credit_note')).rejects.toThrow('db down');
});
