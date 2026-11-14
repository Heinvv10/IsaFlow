/**
 * PATCH /api/accounting/supplier-credit-notes action=post answers approveCreditNote's mirror_bill VAT
 * refusal (migration 988) as a 400 carrying its code — not the route's 500 fallback. It is raised under the
 * bill's key before any write, so the 4xx commits nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(), respondIfImpersonationForbidden: () => false }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(() => ({ kind: 'success' })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    error: vi.fn(() => ({ kind: 'error' })),
  },
  ErrorCode: { SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE' },
}));
const { approveMock } = vi.hoisted(() => ({ approveMock: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  getCreditNotes: vi.fn(), createCreditNote: vi.fn(), approveCreditNote: approveMock, cancelCreditNote: vi.fn(),
  getCreditNoteById: vi.fn(async () => ({ id: 'n1', type: 'supplier' })),
}));

import handler from '../../../pages/api/accounting/supplier-credit-notes';
import { MirroredNoteVatRefusal } from '@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove';
import { apiResponse } from '@/lib/apiResponse';

describe('supplier-credit-notes PATCH post: mirror_bill VAT refusal', () => {
  it('is a 400 with code VAT_ALREADY_REVERSED, not a 500', async () => {
    approveMock.mockRejectedValueOnce(new MirroredNoteVatRefusal('VAT_ALREADY_REVERSED: credit note CN-1 was raised with mirror_bill'));
    const r = await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<{ kind: string }>)(
      { method: 'PATCH', companyId: 'c', user: { id: 'u' }, body: { id: 'n1', action: 'post' } } as unknown as NextApiRequest,
      { setHeader: vi.fn() } as unknown as NextApiResponse,
    );
    expect(r.kind).toBe('badRequest');
    expect(apiResponse.badRequest).toHaveBeenLastCalledWith(expect.anything(), expect.stringMatching(/^VAT_ALREADY_REVERSED/),
      { code: 'VAT_ALREADY_REVERSED' });
    expect(apiResponse.internalError).not.toHaveBeenCalled();
  });
});
