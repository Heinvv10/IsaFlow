/**
 * #1882 fix-verify M1: a supplier refund refused because its supplier was merged away between the sweep line's liveness read and
 * planSupplierRefund's lock is the `supplier_merged` skip, not a refund over the ceiling; any other refund refusal still is one.
 */
import { describe, expect, it } from 'vitest';
import { sweepLineSkip } from '@/modules/accounting/services/bank/bankRuleSweepSkips';
import { SupplierRefundRefusal } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { SUPPLIER_NOT_LIVE_REFUSAL } from '@/modules/accounting/services/core/supplierLiveLock';

describe('sweepLineSkip and a supplier refund refusal', () => {
  it('the supplier merged away meanwhile: supplier_merged', () => {
    expect(sweepLineSkip(new SupplierRefundRefusal(SUPPLIER_NOT_LIVE_REFUSAL))).toBe('supplier_merged');
  });

  it('over the credit the supplier holds: refund_ceiling', () => {
    expect(sweepLineSkip(new SupplierRefundRefusal('A refund of 10.00 exceeds the 0.00 Acme has on account as at 2026-06-20.'))).toBe('refund_ceiling');
  });
});
