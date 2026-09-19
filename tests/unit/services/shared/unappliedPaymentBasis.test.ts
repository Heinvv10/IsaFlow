/**
 * ONE definition of "unapplied payment", shared by the two tools that report it.
 *
 * `list_unapplied_payments` counted `total_amount − Σ payment_allocations` over
 * processed and reconciled payments, above a one-cent threshold, uncapped.
 * `reconcile_subledger` counted the payment's POSTED CONTROL MOVEMENT minus its
 * allocations, over every non-cancelled payment, at a threshold of exactly
 * zero. Two tools answering "how much cash is unapplied" with two different
 * numbers is worse than either being wrong: whichever a reader saw first
 * decided the answer.
 *
 * The basis is the DOCUMENT: total_amount − Σ allocations, allocations capped
 * at the total, counted when the remainder survives round2 above zero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlFn(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getUnappliedPaymentBasis } from '@/modules/accounting/services/shared/unappliedPaymentBasis';

const COMPANY = '11111111-1111-4111-8111-111111111111';

/** The query text actually handed to Postgres, not the source file. */
const queryText = (call: unknown[]): string => (call[0] as string[]).join('?');

const basisRow = (over: Record<string, unknown> = {}) => ({
  id: 'sp1',
  document_number: 'SP-2026-00001',
  document_date: '2026-05-01',
  entity_id: 'dddddddd-0000-4000-8000-000000000001',
  entity_name: 'Acme Supplies',
  attributed: true,
  total_amount: '100000',
  allocated_amount: '0',
  status: 'processed',
  reference: 'EFT-771',
  description: 'March account',
  gl_journal_entry_id: 'je1',
  created_at: '2026-05-01T08:00:00.000Z',
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

/** rows, then the independent aggregate, then the allocation high-water mark. */
function mockBasis(rows: unknown[], allocMax: unknown = null, totals: unknown = totalsRow()) {
  sqlFn
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce([totals])
    .mockResolvedValueOnce([{ posted_through: allocMax }]);
}

beforeEach(() => sqlFn.mockReset());

describe('getUnappliedPaymentBasis', () => {
  it('reports a partly applied payment for its REMAINDER only', async () => {
    mockBasis([basisRow({ total_amount: '100000', allocated_amount: '40000' })]);
    const res = await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      totalAmount: 100000,
      allocatedAmount: 40000,
      unappliedAmount: 60000,
    });
  });

  it('counts a remainder of R0.006 and drops one of R0.004', async () => {
    // round2 is the threshold, not a bare epsilon. R0.004 rounds to zero and is
    // rounding noise; R0.006 rounds to a cent and is money. The old AP tool
    // used `> 0.01`, which dropped a whole cent, and the reconciler used
    // `!== 0`, which kept a ten-thousandth of one.
    mockBasis([
      basisRow({ id: 'keep', total_amount: '10.006', allocated_amount: '0' }),
      basisRow({ id: 'drop', total_amount: '10.004', allocated_amount: '10' }),
    ]);
    const res = await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    expect(res.rows.map((r) => r.paymentId)).toEqual(['keep']);
    expect(res.rows[0]!.unappliedAmount).toBe(10.01);
  });

  it('caps the allocated amount at the payment total', async () => {
    // An over-allocated payment is a defect worth seeing elsewhere; here it
    // must not produce NEGATIVE unapplied cash, which would net off a real
    // remainder somewhere else in the same total.
    mockBasis([basisRow({ total_amount: '1000', allocated_amount: '1500' })]);
    const res = await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    expect(res.rows).toEqual([]);
  });

  it('counts ONLY posted supplier payments — draft, approved and cancelled are out', async () => {
    mockBasis([]);
    await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    const q = queryText(sqlFn.mock.calls[0]!);
    expect(q).toContain("sp.status IN ('processed', 'reconciled')");
    // AR's predicate. A supplier payment at draft or approved passes it and has
    // no journal behind it — cash claimed on a control account it never reached.
    expect(q).not.toContain("<> 'cancelled'");
  });

  it('counts every non-cancelled customer receipt — a receipt is born confirmed', async () => {
    mockBasis([]);
    await getUnappliedPaymentBasis(COMPANY, 'ar', '2026-09-08');
    const q = queryText(sqlFn.mock.calls[0]!);
    expect(q).toContain("cp.status <> 'cancelled'");
  });

  it('counts and sums the population with a SECOND statement, not by measuring the rows', async () => {
    // buildEnvelope checks rowsTotal + excluded === universeTotal. A universe
    // taken from the rows it is checking cannot fail — CONTRACTS.md §1.
    mockBasis(
      [basisRow()],
      null,
      totalsRow({ universe_total: 39, rows_total: 38, total_unapplied: '37719269.77', total_unattributed: '25000' }),
    );
    const res = await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    expect(res.rows).toHaveLength(1);
    expect(res.totals).toMatchObject({
      universeTotal: 39, rowsTotal: 38, totalUnapplied: 37719269.77, totalUnattributed: 25000,
    });
  });

  it('applies the same capped, rounded threshold in the aggregate as in the rows', async () => {
    // Three statements, one predicate. A page filtered differently from its
    // totals is a report whose completeness check cannot mean anything.
    mockBasis([]);
    await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    const population = sqlFn.mock.calls.slice(0, 2).map(queryText);
    expect(population).toHaveLength(2);
    for (const q of population) {
      // `GREATEST(sp.total_amount, 0)` is the cap, not the total itself. The
      // upper bound stops an over-allocated payment reading as negative
      // unapplied cash; the ZERO is what admits a REFUND (migration 681),
      // whose negative total would otherwise cap its own allocations and
      // compute a remainder of exactly zero — dropping it from every figure
      // built on this basis.
      expect(q.replace(/\s+/g, ' ')).toContain(
        'LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0))');
      // `<> 0`, not `> 0`: a refund's remainder is negative and is a row.
      expect(q.replace(/\s+/g, ' ')).toContain(', 2) <> 0');
      expect(q).toContain("sp.status IN ('processed', 'reconciled')");
    }
  });

  it('reads AP allocations from payment_allocations, the table AP actually posts to', async () => {
    mockBasis([]);
    await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    for (const q of sqlFn.mock.calls.map(queryText)) {
      // Migration 201's supplier_payment_allocations holds zero rows and
      // nothing writes it: a remainder computed from it reports every payment
      // as wholly unapplied.
      expect(q).not.toContain('supplier_payment_allocations');
    }
  });

  it('states attribution in the QUERY, so the mapper never guesses from a null name', async () => {
    mockBasis([basisRow({ entity_name: null, attributed: true })]);
    const res = await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    expect(queryText(sqlFn.mock.calls[0]!)).toContain('AS attributed');
    // A real, non-deleted supplier whose `name` column is null stays attributed.
    expect(res.rows[0]).toMatchObject({ attributed: true, entityId: 'dddddddd-0000-4000-8000-000000000001', entityName: null });
  });

  it('drops the entity id when the counterparty row is gone', async () => {
    mockBasis([basisRow({ attributed: false, entity_name: null })]);
    const res = await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    expect(res.rows[0]).toMatchObject({ attributed: false, entityId: null, entityName: null });
  });

  it('scopes every read by company_id and passes as_at as a string', async () => {
    mockBasis([]);
    await getUnappliedPaymentBasis(COMPANY, 'ar', '2026-02-28');
    for (const call of sqlFn.mock.calls) {
      expect(call.slice(1)).toContain(COMPANY);
    }
    const values = sqlFn.mock.calls[0]!.slice(1);
    expect(values).toContain('2026-02-28');
    expect(values.every((v: unknown) => !(v instanceof Date))).toBe(true);
  });

  it('reports the newest allocation timestamp separately from the payments', async () => {
    // An allocation written a minute ago changes an unapplied amount without
    // touching the payment row, so a posted_through from payments alone claims
    // the figure is re-derivable when it is not.
    mockBasis([basisRow()], '2026-09-07T17:58:00.000Z');
    const res = await getUnappliedPaymentBasis(COMPANY, 'ap', '2026-09-08');
    expect(res.allocationsPostedThrough).toBe('2026-09-07T17:58:00.000Z');
    expect(res.totals.postedThrough).toBe('2026-05-01T08:00:00.000Z');
  });
});
