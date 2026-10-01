/**
 * Supplier payments in the ledger and attached to no bill — the AP mirror of
 * the unapplied-receipt report.
 *
 * WHAT COUNTS AS UNAPPLIED IS NO LONGER DECIDED HERE. The basis, the threshold
 * and the status filter moved to `shared/unappliedPaymentBasis.ts`, which
 * `reconcile_subledger` reads through the same function; those rules are
 * asserted in `tests/unit/services/shared/unappliedPaymentBasis.test.ts`, once.
 * Two tools that answered "how much supplier cash is unapplied" with two
 * different numbers is the defect that produced this split.
 *
 * What is left here, and what these cases cover: paging, the attributed /
 * unattributed split, and totals taken from the POPULATION rather than the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const basisFn = vi.fn();
vi.mock('@/modules/accounting/services/shared/unappliedPaymentBasis', () => ({
  getUnappliedPaymentBasis: (...a: unknown[]) => basisFn(...a),
}));

import { getUnappliedPayments } from '@/modules/accounting/services/ap/unappliedPaymentService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

const basisRow = (over: Record<string, unknown> = {}) => ({
  paymentId: 'sp1',
  paymentNumber: 'SP-2026-00001',
  paymentDate: '2026-05-01',
  entityId: 'dddddddd-0000-4000-8000-000000000001',
  entityName: 'Acme Supplies',
  attributed: true,
  totalAmount: 100000,
  allocatedAmount: 0,
  unappliedAmount: 100000,
  status: 'processed',
  reference: 'EFT-771',
  description: 'March account',
  journalEntryId: 'je1',
  createdAt: '2026-05-01T08:00:00.000Z',
  ...over,
});

type Row = ReturnType<typeof basisRow>;

/**
 * The basis's own aggregate is a SEPARATE statement from its rows, so the mock
 * takes it separately too. Where a case does not care, it is derived from the
 * rows — which is exactly what the production code may not do.
 */
function mockBasis(
  rows: unknown[],
  allocationsPostedThrough: string | null = null,
  totals?: Partial<{ universeTotal: number; rowsTotal: number; totalUnapplied: number; totalUnattributed: number; postedThrough: string | null }>,
) {
  const rs = rows as Row[];
  const attributed = rs.filter((r) => r.attributed);
  const orphans = rs.filter((r) => !r.attributed);
  const add = (list: Row[]) => Math.round(list.reduce((s, r) => s + r.unappliedAmount, 0) * 100) / 100;
  basisFn.mockResolvedValue({
    rows,
    allocationsPostedThrough,
    totals: {
      universeTotal: rs.length,
      rowsTotal: attributed.length,
      totalUnapplied: add(attributed),
      totalUnattributed: add(orphans),
      postedThrough: rs.reduce<string | null>((m, r) => (m === null || (r.createdAt ?? '') > m ? r.createdAt : m), null),
      ...totals,
    },
  });
}

beforeEach(() => basisFn.mockReset());

describe('getUnappliedPayments', () => {
  it('reads the AP side of the shared basis, for the company and date it was given', async () => {
    mockBasis([]);
    await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    expect(basisFn).toHaveBeenCalledWith(COMPANY, 'ap', '2026-09-08');
  });

  it('reports a partly applied payment for its REMAINDER only', async () => {
    mockBasis([basisRow({ totalAmount: 100000, allocatedAmount: 40000, unappliedAmount: 60000 })]);

    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    const row = res.rows[0]!;
    expect(row.paymentAmount).toBe(100000);
    expect(row.allocatedAmount).toBe(40000);
    // Reporting only the WHOLLY unallocated payments would miss this R60,000
    // entirely; reporting the R100,000 would double-count the applied part.
    expect(row.unappliedAmount).toBe(60000);
    expect(res.totalUnapplied).toBe(60000);
  });

  it('counts a payment whose supplier is gone in the totals, and never drops it', async () => {
    mockBasis([
      basisRow({
        paymentId: 'sp9', attributed: false, entityId: null, entityName: null,
        totalAmount: 25000, unappliedAmount: 25000,
      }),
    ]);

    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    // Not in `rows`, but present, named and priced. The cash is real whether or
    // not the supplier record still is.
    expect(res.rows).toEqual([]);
    expect(res.unattributed).toHaveLength(1);
    expect(res.unattributed[0]).toMatchObject({
      paymentId: 'sp9', supplierId: null, supplierName: null, unappliedAmount: 25000,
    });
    expect(res.totalUnattributed).toBe(25000);
    // The completeness identity the caller's envelope checks.
    expect(res.rowsTotal + res.unattributed.length).toBe(res.universeTotal);
  });

  it('names the supplier on an attributed payment', async () => {
    mockBasis([basisRow()]);
    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    expect(res.rows[0]).toMatchObject({
      supplierId: 'dddddddd-0000-4000-8000-000000000001',
      supplierName: 'Acme Supplies',
    });
  });

  it('keeps a supplier with a NULL name on the attributed page, not in the orphans', async () => {
    // The basis already decided this row is attributed — it matched a live,
    // non-deleted supplier. Re-deriving that from the NAME would move a live
    // supplier's cash into the orphan stream.
    mockBasis([basisRow({ entityName: null })]);

    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.supplierId).toBe('dddddddd-0000-4000-8000-000000000001');
    expect(res.rows[0]!.supplierName).toBeNull();
    expect(res.unattributed).toEqual([]);
  });

  it('takes the totals from the population, NOT from the page', async () => {
    mockBasis(
      Array.from({ length: 39 }, (_, i) => basisRow({
        paymentId: `sp${String(i).padStart(2, '0')}`,
        paymentDate: `2026-05-${String(i + 1).padStart(2, '0')}`,
        totalAmount: 1000, unappliedAmount: 1000,
      })),
      null,
      { universeTotal: 39, rowsTotal: 39, totalUnapplied: 39000 },
    );

    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 1 });
    expect(res.rows).toHaveLength(1);
    // One row served, thirty-nine counted. A total that follows the page is the
    // more dangerous error: it looks complete.
    expect(res.rowsTotal).toBe(39);
    expect(res.universeTotal).toBe(39);
    expect(res.totalUnapplied).toBe(39000);
  });

  it('resumes AFTER the cursor row, never on it', async () => {
    mockBasis([
      basisRow({ paymentId: 'a', paymentDate: '2026-05-01' }),
      basisRow({ paymentId: 'b', paymentDate: '2026-05-02' }),
      basisRow({ paymentId: 'c', paymentDate: '2026-05-03' }),
    ]);
    const res = await getUnappliedPayments(COMPANY, {
      asAt: '2026-09-08', limit: 50, after: { paymentDate: '2026-05-01', id: 'a' },
    });
    // Serving the cursor row again double-counts it for a caller that sums
    // pages, and a page that never advances loops forever.
    expect(res.rows.map((r) => r.paymentId)).toEqual(['b', 'c']);
  });

  it('breaks a same-date cursor tie on the id, as the ordering does', async () => {
    mockBasis([
      basisRow({ paymentId: 'a', paymentDate: '2026-05-01' }),
      basisRow({ paymentId: 'b', paymentDate: '2026-05-01' }),
    ]);
    const res = await getUnappliedPayments(COMPANY, {
      asAt: '2026-09-08', limit: 50, after: { paymentDate: '2026-05-01', id: 'a' },
    });
    expect(res.rows.map((r) => r.paymentId)).toEqual(['b']);
  });

  it('advances posted_through when an ALLOCATION is newer than every payment', async () => {
    mockBasis([basisRow({ createdAt: '2026-05-01T08:00:00.000Z' })], '2026-09-07T17:58:00.000Z');
    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    // An allocation written a minute ago changes an unapplied amount without
    // touching the payment row. A posted_through from supplier_payments alone
    // would claim the figure is re-derivable when it is not.
    expect(res.postedThrough).toBe('2026-09-07T17:58:00.000Z');
  });

  it('reports the epoch rather than now() when nothing was read', async () => {
    mockBasis([]);
    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    expect(res.postedThrough).toBe('1970-01-01T00:00:00.000Z');
  });
});
