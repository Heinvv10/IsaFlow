/**
 * POST /api/accounting/supplier-credit-notes charges VAT per line, by the line's VAT type. It used to
 * discard `vatType` and put 15% on the whole note, so a zero-rated or exempt line was saved with VAT the
 * form never showed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(), respondIfImpersonationForbidden: () => false }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(() => ({ kind: 'success' })),
    created: vi.fn(() => ({ kind: 'created' })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    error: vi.fn(() => ({ kind: 'error' })),
  },
  ErrorCode: { SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE' },
}));
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  getCreditNotes: vi.fn(), createCreditNote: createMock, approveCreditNote: vi.fn(), cancelCreditNote: vi.fn(),
  getCreditNoteById: vi.fn(),
}));

import handler from '../../../pages/api/accounting/supplier-credit-notes';

type Line = { description: string; quantity: number; unitPrice: number; vatType?: unknown };
const post = (lineItems: Line[], creditDate = '2026-11-19') =>
  (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<{ kind: string; error?: string }>)(
    { method: 'POST', companyId: 'c', user: { id: 'u' }, body: { supplierId: 's1', creditDate, lineItems } } as unknown as NextApiRequest,
    { setHeader: vi.fn() } as unknown as NextApiResponse,
  );
const created = (): { subtotal: number; taxRate: number; taxAmount: number } => createMock.mock.calls[0]![1];

describe('supplier-credit-notes POST: VAT per line', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ id: 'n1' });
  });

  it('charges VAT only on the standard lines of a mixed note', async () => {
    await post([
      { description: 'a', quantity: 1, unitPrice: 1000, vatType: 'standard' },
      { description: 'b', quantity: 2, unitPrice: 250, vatType: 'zero' },
      { description: 'c', quantity: 1, unitPrice: 250, vatType: 'exempt' },
    ]);
    expect(created()).toMatchObject({ subtotal: 1750, taxAmount: 150, taxRate: 15 });
  });

  it('charges no VAT on a note with no standard line', async () => {
    await post([{ description: 'a', quantity: 1, unitPrice: 800, vatType: 'zero_rated' }]);
    expect(created()).toMatchObject({ subtotal: 800, taxAmount: 0, taxRate: 0 });
  });

  it('still charges the standard rate on a line that names no type', async () => {
    await post([{ description: 'a', quantity: 1, unitPrice: 100 }]);
    expect(created()).toMatchObject({ subtotal: 100, taxAmount: 15, taxRate: 15 });
  });

  it('takes the rate from the credit date, not from the request', async () => {
    await post([{ description: 'a', quantity: 1, unitPrice: 100, vatType: 'standard' }], '2018-03-31');
    expect(created()).toMatchObject({ taxAmount: 14, taxRate: 14 });
  });

  it('refuses an unknown VAT type before anything is written', async () => {
    const r = await post([{ description: 'a', quantity: 1, unitPrice: 100, vatType: 'STANDARD' }]);
    expect(r.kind).toBe('badRequest');
    expect(r.error).toMatch(/Line 1.*VAT type/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a credit date that is not a calendar day', async () => {
    const r = await post([{ description: 'a', quantity: 1, unitPrice: 100, vatType: 'standard' }], 'soon');
    expect(r.kind).toBe('badRequest');
    expect(createMock).not.toHaveBeenCalled();
  });
});
