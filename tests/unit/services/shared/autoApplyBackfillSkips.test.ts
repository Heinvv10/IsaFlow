/**
 * Why the auto-apply back-fill may not touch a source — the refund arm.
 *
 * A REFUND (migration 681) is a negative on-account entry: cash the company
 * sent back, carrying no allocations and a NEGATIVE remainder. "Applying" one
 * to an open bill would write a negative allocation and un-pay that bill, so
 * the back-fill would be reversing settlements nobody asked it to touch.
 *
 * It is SKIPPED WITH A REASON rather than filtered out of the population,
 * because the plan has to reconcile line for line against
 * `list_unapplied_payments`, which reports the refund. Filtering it would make
 * the plan's total differ from the report an operator is reading beside it, by
 * exactly the amount nobody can account for.
 */
import { describe, it, expect } from 'vitest';

import {
  basisSources, SKIP_REFUND, SKIP_CONTACT_UNRESOLVED,
} from '@/modules/accounting/services/shared/autoApplyBackfillSkips';
import type {
  UnappliedPaymentBasisRow,
} from '@/modules/accounting/services/shared/unappliedPaymentBasis';

const row = (over: Partial<UnappliedPaymentBasisRow> = {}): UnappliedPaymentBasisRow => ({
  paymentId: 'sp1',
  paymentNumber: 'SP-2026-00001',
  paymentDate: '2026-05-01',
  entityId: 'dddddddd-0000-4000-8000-000000000001',
  entityName: 'Acme Supplies',
  attributed: true,
  totalAmount: 1000,
  allocatedAmount: 0,
  unappliedAmount: 1000,
  kind: 'payment',
  status: 'processed',
  reference: 'EFT-771',
  description: 'March account',
  journalEntryId: 'je1',
  createdAt: '2026-05-01T08:00:00.000Z',
  ...over,
});

describe('basisSources — a refund is never applied', () => {
  it('skips a refund, with the refund reason', () => {
    // Remove the `kind === 'refund'` branch and this goes red: the row is
    // attributed, processed and has a journal, so every other guard passes it
    // and `skippedReason` comes back null — the back-fill would then plan a
    // NEGATIVE application against this supplier's oldest open bill.
    const [source] = basisSources('ap', [row({
      kind: 'refund', totalAmount: -400, unappliedAmount: -400,
    })]);
    expect(source!.skippedReason).toBe(SKIP_REFUND);
  });

  it('carries the refund through as a source, negative remainder and all', () => {
    // Not filtered out. The plan's totals have to reconcile against
    // list_unapplied_payments, which reports it.
    const sources = basisSources('ap', [row({
      kind: 'refund', totalAmount: -400, unappliedAmount: -400,
    })]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.remainder).toBe(-400);
  });

  it('names the REFUND before the unresolved contact', () => {
    // A refund whose supplier row was deleted is still a refund. Reporting the
    // contact would send somebody to fix a supplier record that changes nothing
    // about whether this cash may be applied.
    const [source] = basisSources('ap', [row({
      kind: 'refund', attributed: false, entityId: null, entityName: null,
      totalAmount: -400, unappliedAmount: -400,
    })]);
    expect(source!.skippedReason).toBe(SKIP_REFUND);
    expect(source!.skippedReason).not.toBe(SKIP_CONTACT_UNRESOLVED);
  });

  it('leaves an ordinary payment applicable', () => {
    const [source] = basisSources('ap', [row()]);
    expect(source!.skippedReason).toBeNull();
  });

  it('skips a customer refund on the AR side too', () => {
    const [source] = basisSources('ar', [row({
      kind: 'refund', status: 'confirmed', totalAmount: -400, unappliedAmount: -400,
    })]);
    expect(source!.skippedReason).toBe(SKIP_REFUND);
  });
});
