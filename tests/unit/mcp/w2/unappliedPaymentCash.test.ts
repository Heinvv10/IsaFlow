/**
 * Mechanism 1 of the unapplied-cash reader: a payment document whose cash is
 * applied to nothing.
 *
 * WHICH payments are unapplied is the shared basis, asserted once in
 * `tests/unit/services/shared/unappliedPaymentBasis.test.ts`. What is asserted
 * here is the part that cannot move there: a reconciling item's amount is the
 * payment's movement ON THE CONTROL ACCOUNT, because that is what it explains
 * of `subledgerTotal − controlAccountBalance`.
 *
 * On isaflow_dev, Britech has 130 receipts worth R7,505,599 on the document
 * basis against an AR control balance of −R329,700. An item of R7.5m there
 * produces an equal and opposite R7.5m of `unexplained_difference` — the same
 * artefact shape as the control-account posting probe this workstream removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlFn(...a), withTransaction: vi.fn() }));

const basisFn = vi.fn();
vi.mock('@/modules/accounting/services/shared/unappliedPaymentBasis', () => ({
  getUnappliedPaymentBasis: (...a: unknown[]) => basisFn(...a),
}));

import { getUnappliedPaymentCash } from '@/modules/accounting/services/reconciliation/unappliedPaymentCash';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CTRL = ['22222222-2222-4222-8222-222222222222'];

const payment = (over: Record<string, unknown> = {}) => ({
  paymentId: 'p1',
  paymentNumber: 'CP-1',
  paymentDate: '2026-07-24',
  entityId: 'cust-1',
  entityName: 'Velocity Fibre',
  attributed: true,
  totalAmount: 172500,
  allocatedAmount: 0,
  unappliedAmount: 172500,
  status: 'confirmed',
  reference: null,
  description: null,
  journalEntryId: 'je-1',
  createdAt: '2026-07-24T10:00:00.000Z',
  ...over,
});

function mockBasis(rows: unknown[], postedThrough: string | null = null, allocThrough: string | null = null) {
  basisFn.mockResolvedValue({
    rows,
    totals: { universeTotal: rows.length, rowsTotal: rows.length, totalUnapplied: 0, totalUnattributed: 0, postedThrough },
    allocationsPostedThrough: allocThrough,
  });
}

beforeEach(() => {
  sqlFn.mockReset();
  basisFn.mockReset();
});

describe('getUnappliedPaymentCash', () => {
  it('takes the payment set from the shared basis, for the side it was given', async () => {
    mockBasis([]);
    await getUnappliedPaymentCash(COMPANY, 'ap', '2026-09-03', CTRL);
    expect(basisFn).toHaveBeenCalledWith(COMPANY, 'ap', '2026-09-03');
    // No payments, so no movement query: running it with an empty id array
    // would scan every journal line in the company.
    expect(sqlFn).not.toHaveBeenCalled();
  });

  it('reports the movement ON THE CONTROL ACCOUNT, not the document remainder', async () => {
    mockBasis([payment({ totalAmount: 172500, allocatedAmount: 0, unappliedAmount: 172500 })]);
    sqlFn.mockResolvedValueOnce([{ id: 'p1', control_movement: '172500' }]);

    const res = await getUnappliedPaymentCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord[0]).toMatchObject({
      id: 'p1', amount: 172500, documentUnapplied: 172500, gross: 172500,
    });
    // The two agree, so there is nothing off-control to report.
    expect(res.offControl).toEqual([]);
  });

  it('explains NOTHING for a payment whose cash never reached a control account', async () => {
    // settle_by_contra posts DR Accounts Payable / CR <loan account>; a payment
    // whose control leg went elsewhere moves neither side of the difference.
    mockBasis([payment({ paymentId: 'p9', totalAmount: 50000, unappliedAmount: 50000 })]);
    sqlFn.mockResolvedValueOnce([]);

    const res = await getUnappliedPaymentCash(COMPANY, 'ap', '2026-09-03', CTRL);
    expect(res.withPaymentRecord).toEqual([]);
    // ...and it is NOT silent. The listing tools still count this cash, and a
    // reader comparing the two needs the difference named.
    expect(res.offControl).toEqual([
      { paymentId: 'p9', documentNumber: 'CP-1', amount: 50000 },
    ]);
  });

  it('names the part of a partly-on-control payment that is off control', async () => {
    mockBasis([payment({ totalAmount: 100000, allocatedAmount: 0, unappliedAmount: 100000 })]);
    sqlFn.mockResolvedValueOnce([{ id: 'p1', control_movement: '60000' }]);

    const res = await getUnappliedPaymentCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord[0]!.amount).toBe(60000);
    expect(res.offControl[0]!.amount).toBe(40000);
  });

  it('caps allocations at the cash that actually arrived', async () => {
    // An over-allocated payment must not produce a NEGATIVE item that nets off
    // a real remainder on another payment in the same total.
    mockBasis([payment({ totalAmount: 100000, allocatedAmount: 90000, unappliedAmount: 10000 })]);
    sqlFn.mockResolvedValueOnce([{ id: 'p1', control_movement: '40000' }]);

    const res = await getUnappliedPaymentCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord).toEqual([]);
    expect(res.appliedRecords[0]!.amount).toBe(40000);
  });

  it('scopes the movement query by company and passes the date as a string', async () => {
    mockBasis([payment()]);
    sqlFn.mockResolvedValueOnce([]);
    await getUnappliedPaymentCash(COMPANY, 'ar', '2026-09-03', CTRL);
    const values = sqlFn.mock.calls[0]!.slice(1);
    expect(values).toContain(COMPANY);
    expect(values).toContain('2026-09-03');
    expect(values.every((v: unknown) => !(v instanceof Date))).toBe(true);
  });

  it('carries the later of the payment and allocation high-water marks', async () => {
    mockBasis([payment()], '2026-05-01T08:00:00.000Z', '2026-09-07T17:58:00.000Z');
    sqlFn.mockResolvedValueOnce([{ id: 'p1', control_movement: '172500' }]);
    const res = await getUnappliedPaymentCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.postedThrough).toBe('2026-09-07T17:58:00.000Z');
  });
});
