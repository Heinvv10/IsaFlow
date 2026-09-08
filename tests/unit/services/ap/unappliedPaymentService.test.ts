/**
 * Supplier payments in the ledger and attached to no bill — the AP mirror of
 * the unapplied-receipt report.
 *
 * The one difference from AR that matters is the STATUS FILTER, and it is the
 * point of this service. A `customer_payments` row is created already
 * confirmed, so AR filters merely `<> 'cancelled'`. A supplier payment has a
 * lifecycle in front of it: `draft` and `approved` rows have no journal, no
 * cash has left the bank and nothing has touched the AP control account.
 * Listing one as unapplied cash would invent a reconciling item.
 *
 * Three separate queries carry that predicate — the page, the orphan stream and
 * the totals — so the tests below assert it on ALL THREE. Three copies of one
 * predicate is exactly the shape that drifts, and a page filtered differently
 * from its totals is a report whose completeness check cannot fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlFn(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getUnappliedPayments } from '@/modules/accounting/services/ap/unappliedPaymentService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

/** The query text actually handed to Postgres, not the source file. */
const queryText = (call: unknown[]): string => (call[0] as string[]).join('?');

const payRow = (over: Record<string, unknown> = {}) => ({
  id: 'sp1',
  payment_number: 'SP-2026-00001',
  payment_date: '2026-05-01',
  supplier_id: 'dddddddd-0000-4000-8000-000000000001',
  supplier_name: 'Acme Supplies',
  total_amount: '100000',
  allocated_amount: '0',
  status: 'processed',
  reference: 'EFT-771',
  description: 'March account',
  gl_journal_entry_id: 'je1',
  // The page query selects TRUE here and the orphan query FALSE. The mapper
  // reads THIS, not a null name — a real supplier with a null `name` must not
  // be reported as an orphan.
  attributed: true,
  ...over,
});

const totalsRow = (over: Record<string, unknown> = {}) => ({
  universe_total: 1,
  rows_total: 1,
  total_unapplied: '100000',
  total_unattributed: '0',
  posted_through: '2026-05-01T08:00:00.000Z',
  ...over,
});

/** page rows, orphan rows, totals, allocation posted_through — in that order. */
function mockReads(page: unknown[], orphans: unknown[], totals: unknown, allocMax: unknown = null) {
  sqlFn
    .mockResolvedValueOnce(page)
    .mockResolvedValueOnce(orphans)
    .mockResolvedValueOnce([totals])
    .mockResolvedValueOnce([{ posted_through: allocMax }]);
}

beforeEach(() => sqlFn.mockReset());

describe('getUnappliedPayments', () => {
  it('reports a partly applied payment for its REMAINDER only', async () => {
    mockReads(
      [payRow({ total_amount: '100000', allocated_amount: '40000' })],
      [],
      totalsRow({ total_unapplied: '60000' }),
    );

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
    mockReads(
      [],
      [payRow({ id: 'sp9', supplier_name: null, attributed: false, total_amount: '25000' })],
      totalsRow({ universe_total: 1, rows_total: 0, total_unapplied: '0', total_unattributed: '25000' }),
    );

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
    mockReads([payRow()], [], totalsRow());

    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    expect(res.rows[0]).toMatchObject({
      supplierId: 'dddddddd-0000-4000-8000-000000000001',
      supplierName: 'Acme Supplies',
    });
  });

  it('keeps a supplier with a NULL name on the attributed page, not in the orphans', async () => {
    // The page query already decided this row is attributed — it matched
    // `s.id IS NOT NULL`. Re-deriving that from the NAME would contradict the
    // query and move a live supplier's cash into the orphan stream.
    mockReads([payRow({ supplier_name: null })], [], totalsRow());

    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.supplierId).toBe('dddddddd-0000-4000-8000-000000000001');
    expect(res.rows[0]!.supplierName).toBeNull();
    expect(res.unattributed).toEqual([]);
  });

  it('selects the attribution flag from BOTH streams, so the mapper never guesses', async () => {
    mockReads([payRow()], [], totalsRow());
    await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    expect(queryText(sqlFn.mock.calls[0]!)).toContain('TRUE AS attributed');
    expect(queryText(sqlFn.mock.calls[1]!)).toContain('FALSE AS attributed');
  });

  it('takes the totals from the population, NOT from the page', async () => {
    mockReads(
      [payRow()],
      [],
      totalsRow({ universe_total: 39, rows_total: 39, total_unapplied: '37719269.77' }),
    );

    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 1 });
    expect(res.rows).toHaveLength(1);
    // One row served, thirty-nine counted. A total that follows the page is the
    // more dangerous error: it looks complete.
    expect(res.rowsTotal).toBe(39);
    expect(res.universeTotal).toBe(39);
    expect(res.totalUnapplied).toBe(37719269.77);
  });

  it('counts ONLY posted payments — draft, approved and cancelled are excluded', async () => {
    mockReads([], [], totalsRow({ universe_total: 0, rows_total: 0, total_unapplied: '0' }));
    await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });

    // The page, the orphan stream and the totals. All three define the same
    // population, so all three must carry the same predicate.
    const population = sqlFn.mock.calls.slice(0, 3).map(queryText);
    expect(population).toHaveLength(3);
    for (const q of population) {
      expect(q).toContain("sp.status IN ('processed', 'reconciled')");
      // AR's predicate. A supplier payment at `draft` or `approved` passes it
      // and has no journal behind it — cash claimed on a control account it
      // never reached.
      expect(q).not.toContain("<> 'cancelled'");
    }
  });

  it('scopes every read by company_id', async () => {
    mockReads([], [], totalsRow({ universe_total: 0, rows_total: 0, total_unapplied: '0' }));
    await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    for (const call of sqlFn.mock.calls) {
      expect(call.slice(1)).toContain(COMPANY);
    }
  });

  it('reads allocations from payment_allocations, the table AP actually posts to', async () => {
    mockReads([], [], totalsRow({ universe_total: 0, rows_total: 0, total_unapplied: '0' }));
    await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    for (const q of sqlFn.mock.calls.map(queryText)) {
      expect(q).toContain('payment_allocations');
      // Migration 201's table holds zero rows and nothing writes it: a
      // remainder computed from it would report every payment as unapplied.
      expect(q).not.toContain('supplier_payment_allocations');
    }
  });

  it('advances posted_through when an ALLOCATION is newer than every payment', async () => {
    mockReads(
      [payRow()],
      [],
      totalsRow({ posted_through: '2026-05-01T08:00:00.000Z' }),
      '2026-09-07T17:58:00.000Z',
    );
    const res = await getUnappliedPayments(COMPANY, { asAt: '2026-09-08', limit: 50 });
    // An allocation written a minute ago changes an unapplied amount without
    // touching the payment row. A posted_through from supplier_payments alone
    // would claim the figure is re-derivable when it is not.
    expect(res.postedThrough).toBe('2026-09-07T17:58:00.000Z');
  });
});
