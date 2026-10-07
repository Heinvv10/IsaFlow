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
  },
}));
const { approveMock } = vi.hoisted(() => ({ approveMock: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  approveCreditNote: approveMock, cancelCreditNote: vi.fn(), applyCreditNoteToInvoice: vi.fn(),
}));

import handler from '../../../../pages/api/accounting/credit-notes-action';
import { ArPostingAfterWriteError } from '@/modules/accounting/services/ar/arErrors';

const call = () => (handler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<{ kind: string }>)(
  { method: 'POST', companyId: 'c', user: { id: 'u' },
    body: { action: 'approve', creditNoteId: '11111111-1111-4111-8111-111111111111' } } as unknown as NextApiRequest,
  {} as NextApiResponse,
);

describe('credit-notes-action approve: a failure after the journal is written is not a 400', () => {
  it('rethrows ArPostingAfterWriteError so withAuth rolls the draft journal back', async () => {
    approveMock.mockRejectedValueOnce(new ArPostingAfterWriteError('Credit note CN-1 was not approved: period closed'));
    await expect(call()).rejects.toBeInstanceOf(ArPostingAfterWriteError);
  });

  it('still answers a pre-write refusal 400', async () => {
    approveMock.mockRejectedValueOnce(new Error('Cannot approve credit note with status: applied'));
    expect(await call()).toEqual({ kind: 'badRequest', error: 'Cannot approve credit note with status: applied' });
  });
});
