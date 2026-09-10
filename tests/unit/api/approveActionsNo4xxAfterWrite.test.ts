/**
 * The three approve/process actions answer 4xx only for a PRE-WRITE refusal.
 *
 * `withAuth` COMMITs the request transaction on a 4xx and ROLLBACKs only on a
 * 5xx. All three routes caught everything and returned a 400, so a posting that
 * failed after the journal was created had that partial work committed and
 * reported to the user as a validation error. Each now maps only the typed
 * status refusal — raised before the first posting — and rethrows the rest so
 * `withErrorHandler` turns it into a 500 and the transaction rolls back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  approveSupplierPayment: vi.fn(),
  processSupplierPayment: vi.fn(),
}));

import { processSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentService';
import { SupplierPaymentNotProcessableError } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { approveWriteOff, WriteOffNotApprovableError } from '@/modules/accounting/services/ar/writeOffService';
import { approveAdjustment, AdjustmentNotApprovableError } from '@/modules/accounting/services/items/adjustmentService';
import paymentHandler from '../../../pages/api/accounting/supplier-payments-action';
import writeOffHandler from '../../../pages/api/accounting/write-offs-action';
import adjustmentHandler from '../../../pages/api/accounting/adjustments-action';

vi.mock('@/modules/accounting/services/ar/writeOffService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/writeOffService')>()),
  approveWriteOff: vi.fn(),
  cancelWriteOff: vi.fn(),
}));
vi.mock('@/modules/accounting/services/items/adjustmentService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/items/adjustmentService')>()),
  approveAdjustment: vi.fn(),
  cancelAdjustment: vi.fn(),
}));

const mockPayment = processSupplierPayment as unknown as ReturnType<typeof vi.fn>;
const mockWriteOff = approveWriteOff as unknown as ReturnType<typeof vi.fn>;
const mockAdjustment = approveAdjustment as unknown as ReturnType<typeof vi.fn>;

const ID = '11111111-1111-1111-1111-111111111111';

function makeRes() {
  const res = { statusCode: 200 } as unknown as NextApiResponse & { body?: unknown };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = vi.fn((b: unknown) => { (res as { body?: unknown }).body = b; return res; }) as never;
  return res;
}

const post = (body: unknown) => ({
  method: 'POST', user: { id: 'u1' }, companyId: 'c1', body,
} as unknown as NextApiRequest);

const dbError = () => Object.assign(new Error('duplicate key'), { code: '23505' });

beforeEach(() => vi.clearAllMocks());

describe('supplier-payments-action process', () => {
  it('answers 409 when the payment is no longer approved', async () => {
    mockPayment.mockRejectedValueOnce(new SupplierPaymentNotProcessableError('processed'));
    const res = makeRes();
    await paymentHandler(post({ action: 'process', paymentId: ID }) as never, res as never);
    expect(res.statusCode).toBe(409);
  });

  it('propagates any other failure so the request transaction rolls back', async () => {
    const err = dbError();
    mockPayment.mockRejectedValueOnce(err);
    const res = makeRes();
    await expect(paymentHandler(post({ action: 'process', paymentId: ID }) as never, res as never)).rejects.toBe(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('write-offs-action approve', () => {
  it('answers 409 when the write-off is no longer draft', async () => {
    mockWriteOff.mockRejectedValueOnce(new WriteOffNotApprovableError('approved'));
    const res = makeRes();
    await writeOffHandler(post({ action: 'approve', id: ID }) as never, res as never);
    expect(res.statusCode).toBe(409);
  });

  it('propagates any other failure so the request transaction rolls back', async () => {
    const err = dbError();
    mockWriteOff.mockRejectedValueOnce(err);
    const res = makeRes();
    await expect(writeOffHandler(post({ action: 'approve', id: ID }) as never, res as never)).rejects.toBe(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('adjustments-action approve', () => {
  it('answers 409 when the adjustment is no longer draft', async () => {
    mockAdjustment.mockRejectedValueOnce(new AdjustmentNotApprovableError('cancelled'));
    const res = makeRes();
    await adjustmentHandler(post({ action: 'approve', id: ID }) as never, res as never);
    expect(res.statusCode).toBe(409);
  });

  it('propagates any other failure so the request transaction rolls back', async () => {
    const err = dbError();
    mockAdjustment.mockRejectedValueOnce(err);
    const res = makeRes();
    await expect(adjustmentHandler(post({ action: 'approve', id: ID }) as never, res as never)).rejects.toBe(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});
