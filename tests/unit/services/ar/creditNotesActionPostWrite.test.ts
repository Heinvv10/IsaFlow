/**
 * POST /api/accounting/credit-notes-action answers an approve failure 400 —
 * except one raised AFTER the note's journal was written
 * (ArPostingAfterWriteError), which it rethrows so withAuth answers 500 and
 * ROLLS BACK: a 400 would commit the orphan draft auto_credit_note journal.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(() => ({ kind: 'success' })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    validationError: vi.fn(() => ({ kind: 'validationError' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    error: vi.fn(() => ({ kind: 'error' })),
  },
  ErrorCode: { SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE' },
}));
const { approveMock } = vi.hoisted(() => ({ approveMock: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  approveCreditNote: approveMock, cancelCreditNote: vi.fn(), applyCreditNoteToInvoice: vi.fn(),
}));

import handler from '../../../../pages/api/accounting/credit-notes-action';
import { ArPostingAfterWriteError } from '@/modules/accounting/services/ar/arErrors';
import { CreditNoteDimensionRefusal } from '@/modules/accounting/services/ar/creditNoteHeaderTags';
import { afterJournalWritten } from '@/modules/accounting/services/ar/creditNotePostingChecks';
import { apiResponse } from '@/lib/apiResponse';

const call = (res: NextApiResponse = {} as NextApiResponse) => (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<{ kind: string }>)(
  { method: 'POST', companyId: 'c', user: { id: 'u' },
    body: { action: 'approve', creditNoteId: '11111111-1111-4111-8111-111111111111' } } as unknown as NextApiRequest,
  res,
);

describe('credit-notes-action approve: a failure after the journal is written is not a 400', () => {
  it('rethrows ArPostingAfterWriteError so withAuth rolls the draft journal back', async () => {
    approveMock.mockRejectedValueOnce(new ArPostingAfterWriteError('Credit note CN-1 was not approved: period closed'));
    await expect(call()).rejects.toBeInstanceOf(ArPostingAfterWriteError);
  });

  it('answers a header-tag refusal 400 with its code (pre-write)', async () => {
    approveMock.mockRejectedValueOnce(new CreditNoteDimensionRefusal('A credit note linked to an invoice reverses that invoice\'s own revenue lines'));
    await call();
    expect(apiResponse.badRequest).toHaveBeenLastCalledWith(expect.anything(), expect.stringMatching(/linked to an invoice/),
      { code: 'CREDIT_NOTE_DIMENSIONS_REFUSED' });
  });

  it('still answers a pre-write refusal 400', async () => {
    approveMock.mockRejectedValueOnce(new Error('Cannot approve credit note with status: applied'));
    expect(await call()).toEqual({ kind: 'badRequest', error: 'Cannot approve credit note with status: applied' });
  });
});

describe('after the journal is written, a held row keeps its retryable class', () => {
  const held = () => Object.assign(new Error('Credit note row is held by another request — retry in a moment.'), { code: 'CREDIT_NOTE_LOCK_TIMEOUT' });

  it('afterJournalWritten passes a held row through and wraps anything else', async () => {
    const h = held();
    await expect(afterJournalWritten('CN-1', async () => { throw h; })).rejects.toBe(h);
    const raw = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    await expect(afterJournalWritten('CN-1', async () => { throw raw; })).rejects.toBe(raw);
    const other = new Error('period closed');
    const err = await afterJournalWritten('CN-1', async () => { throw other; }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArPostingAfterWriteError);
    expect((err as Error).cause).toBe(other);
  });

  it('credit-notes-action answers a held row 503 + Retry-After, never 400', async () => {
    vi.clearAllMocks();
    approveMock.mockRejectedValueOnce(held());
    const res = { setHeader: vi.fn() } as unknown as NextApiResponse;
    await call(res);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(apiResponse.error).toHaveBeenCalledWith(res, 'SERVICE_UNAVAILABLE', expect.any(String), { code: 'CREDIT_NOTE_LOCK_TIMEOUT' });
    expect(apiResponse.badRequest).not.toHaveBeenCalled();
  });
});
