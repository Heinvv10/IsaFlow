/**
 * D11 round 2 (brk-d11 F1): `attachEvidenceAndSettleApproved` ran the settlement in a savepoint and treated ANY failure
 * but a typed lock timeout as a refusal: a 40P01 deadlock victim there withdrew the auto-approval to draft and the route
 * answered 200 with the slip claimed. All contention (typed timeout, raw 55P03 / 40P01, `CAPTURE_EVENT_LOCKED`, a held
 * refusal) is re-thrown, so the request rolls back and a retry settles it. An ordinary refusal still withdraws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({ postSupplierInvoiceToGL: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/evidenceAttachmentService', () => ({ attachEvidenceToProvisional: vi.fn() }));

import { sql } from '@/lib/neon';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import { CaptureEventLockedError } from '@/modules/accounting/services/capture/captureEventLock';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';

const input = { companyId: 'c', documentId: 'd', invoiceId: 'i', userId: 'u', invoiceStatus: 'approved',
  supplierId: 's', totalAmount: 10, invoiceDate: '2026-09-01' };
const pg = (code: string) => Object.assign(new Error('driver text'), { code });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(attachEvidenceToProvisional).mockResolvedValue({ attachedJeId: 'je', bankTxId: 'bt' } as never);
});

describe('attachEvidenceAndSettleApproved: contention is re-thrown, never a refusal', () => {
  it.each([
    ['a raw 40P01 deadlock victim', () => pg('40P01')],
    ['a raw 55P03 lock timeout', () => pg('55P03')],
    ['a typed lock timeout', () => new PaymentLockTimeoutError('p')],
    ['CaptureEventLockedError', () => new CaptureEventLockedError('e')],
    ['a held SupplierPaymentRefusal', () => new SupplierPaymentRefusal('x', { retryable: true, held: true })],
  ])('%s', async (_n, make) => {
    vi.mocked(postSupplierInvoiceToGL).mockRejectedValueOnce(make());
    await expect(attachEvidenceAndSettleApproved(input)).rejects.toBeDefined();
    expect(sql).not.toHaveBeenCalled(); // the auto-approval was NOT withdrawn
  });

  it('an ordinary refusal still withdraws the auto-approval and reports it', async () => {
    vi.mocked(postSupplierInvoiceToGL).mockRejectedValueOnce(new Error('period closed'));
    vi.mocked(sql).mockResolvedValue([] as never);
    const out = await attachEvidenceAndSettleApproved(input);
    expect(out.settlementRefused).toBe('period closed');
    expect(sql).toHaveBeenCalledTimes(1);
  });
});
