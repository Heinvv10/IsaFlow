/**
 * Create-and-post (POST submitAction:'post') into a period that is not open is refused BEFORE the draft is written:
 * a clean 400 with nothing created. A 4xx after the draft would be committed by withAuth and leave an orphan draft;
 * a 5xx would roll back but mask the reason. The page's warn-only date field relies on this sentence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/impersonationGuard')>()), assertNotImpersonating: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/core/approvePermission')>()),
  assertMayApprove: vi.fn(), mayApprove: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({ getPeriodStatusForDate: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteService')>()),
  createCreditNote: vi.fn(),
}));
vi.mock('@/modules/accounting/services/shared/creditNoteFifo', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/shared/creditNoteFifo')>()),
  listCreditNoteAllocations: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteApproveService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/creditNoteApproveService')>()),
  approveCreditNote: vi.fn(),
}));

import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import handler from '../../../pages/api/accounting/supplier-credit-notes';

const BODY = {
  supplierId: '44444444-4444-4444-8444-444444444444', creditDate: '2026-03-15', description: 'x',
  lineItems: [{ description: 'a', quantity: 1, unitPrice: 100 }],
};
function post(body: Record<string, unknown>) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; }, setHeader() { return this; } };
  const req = { method: 'POST', body, query: {}, headers: {}, user: { id: '33333333-3333-4333-8333-333333333333' }, companyId: '11111111-1111-4111-8111-111111111111' };
  return (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req as never, res as never).then(() => res);
}

beforeEach(() => {
  vi.mocked(getPeriodStatusForDate).mockReset().mockResolvedValue('open');
  vi.mocked(createCreditNote).mockReset().mockResolvedValue({ id: 'n1', type: 'supplier', status: 'draft' } as never);
  vi.mocked(approveCreditNote).mockReset().mockResolvedValue({ id: 'n1', status: 'approved' } as never);
});

describe('supplier-credit-notes POST submitAction:post into a period that is not open', () => {
  it('answers 400 and writes nothing: the draft is never created', async () => {
    vi.mocked(getPeriodStatusForDate).mockResolvedValue('closed');
    const res = await post({ ...BODY, submitAction: 'post' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/closed fiscal period/);
    expect(JSON.stringify(res.body)).toMatch(/nothing was saved/i);
    expect(createCreditNote).not.toHaveBeenCalled();
    expect(approveCreditNote).not.toHaveBeenCalled();
    expect(getPeriodStatusForDate).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', '2026-03-15');
  });
  it('a draft is still saved into that period (only the post is refused)', async () => {
    vi.mocked(getPeriodStatusForDate).mockResolvedValue('closed');
    const res = await post({ ...BODY, submitAction: 'draft' });
    expect(res.statusCode).toBe(201);
    expect(createCreditNote).toHaveBeenCalledTimes(1);
    expect(approveCreditNote).not.toHaveBeenCalled();
  });
  it.each(['abc', '2026-13-45', '2026-02-30'])('a malformed creditDate %s skips the lookup and is still the 400 it was', async (creditDate) => {
    const res = await post({ ...BODY, creditDate, submitAction: 'post' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/creditDate must be a date/);
    expect(getPeriodStatusForDate).not.toHaveBeenCalled();
    expect(createCreditNote).not.toHaveBeenCalled();
  });
  it.each(['open', 'no_period'] as const)('%s: creates and posts (no_period gets its year created on posting)', async (st) => {
    vi.mocked(getPeriodStatusForDate).mockResolvedValue(st);
    const res = await post({ ...BODY, submitAction: 'post' });
    expect(res.statusCode).toBe(201);
    expect(createCreditNote).toHaveBeenCalledTimes(1);
    expect(approveCreditNote).toHaveBeenCalledTimes(1);
  });
});
