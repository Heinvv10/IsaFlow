/**
 * Posting a supplier credit note into a period that is not open answers 400 with the real reason, not a masked 500
 * (the page's warn-only date field relies on the server's sentence). Real route handler; the post service refuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/core/approvePermission')>()),
  assertMayApprove: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteService')>()),
  getCreditNoteById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteApproveService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteApproveService')>()),
  approveCreditNote: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteCancelService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteCancelService')>()),
  cancelCreditNote: vi.fn(),
}));

import { getCreditNoteById } from '@/modules/accounting/services/ar/creditNoteService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import handler from '../../../pages/api/accounting/supplier-credit-notes';

const NOTE = '22222222-2222-4222-8222-222222222222';
function patch(body: Record<string, unknown>) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; }, setHeader() { return this; } };
  const req = { method: 'PATCH', body, query: {}, headers: {}, user: { id: '33333333-3333-4333-8333-333333333333' }, companyId: '11111111-1111-4111-8111-111111111111' };
  return (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req as never, res as never).then(() => res);
}

beforeEach(() => {
  vi.mocked(getCreditNoteById).mockResolvedValue({ id: NOTE, type: 'supplier', status: 'draft' } as never);
  vi.mocked(approveCreditNote).mockReset();
  vi.mocked(cancelCreditNote).mockReset();
});

describe('supplier-credit-notes PATCH post into a period that is not open', () => {
  it.each(['closed', 'locked', 'closing'])('answers 400 naming the %s period, not a 500', async (status) => {
    vi.mocked(approveCreditNote).mockRejectedValue(new ClosedFiscalPeriodError(status));
    const res = await patch({ id: NOTE, action: 'post' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain(`Cannot post to ${status} fiscal period`);
  });
});

describe('supplier-credit-notes PATCH reverse into a period that is not open', () => {
  it('answers 400 with the reason (the same mapping, inside the same savepoint)', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue({ id: NOTE, type: 'supplier', status: 'approved' } as never);
    vi.mocked(cancelCreditNote).mockRejectedValue(new ClosedFiscalPeriodError('closed'));
    const res = await patch({ id: NOTE, action: 'reverse' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Cannot post to closed fiscal period');
  });
});
