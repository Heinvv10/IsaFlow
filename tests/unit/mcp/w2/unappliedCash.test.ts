/**
 * Unapplied cash on a control account (W2).
 *
 * TWO mechanisms put cash on the AR control account without applying it, and a
 * reconciler that sees only the first reports a clean set of books:
 *
 *  B2  — `allocateTransaction(allocType='customer')` posts DR Bank / CR AR and
 *        writes NO allocation rows and NO amount_paid. A `customer_payments`
 *        row exists with nothing allocated against it.
 *  B24 — the SAME code path SKIPS its payment INSERT when it cannot resolve a
 *        uuid-shaped user, so the cash reaches the control account by plain
 *        journal with no `customer_payments` row behind it at all.
 *        W1's `list_unapplied_receipts` cannot see this state. This must.
 *
 * MECHANISM 1 IS NOT IMPLEMENTED HERE ANY MORE. It is `unappliedPaymentCash.ts`
 * — the shared basis for which payments, their movement on the control account
 * for how much — and it has its own suite. What these cases cover is that BOTH
 * mechanisms are reported, apart, and totalled together.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({
  // unsafe: the deleted-document chain fragment (shared/softDeleteLedgerPresence).
  sql: Object.assign((...a: unknown[]) => sqlFn(...a), { unsafe: vi.fn((s: string) => s) }),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const paymentCashFn = vi.fn();
vi.mock('@/modules/accounting/services/reconciliation/unappliedPaymentCash', () => ({
  getUnappliedPaymentCash: (...a: unknown[]) => paymentCashFn(...a),
}));

import { getUnappliedControlCash } from '@/modules/accounting/services/reconciliation/unappliedCashService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CTRL = ['22222222-2222-4222-8222-222222222222'];

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  documentNumber: 'CP-2026-00001',
  entityName: 'Velocity Fibre',
  documentDate: '2026-07-24',
  amount: 172500,
  documentUnapplied: 172500,
  gross: 172500,
  ...over,
});

function mockBasis(rows: unknown[], postedThrough: string | null = null, offControl: unknown[] = []) {
  paymentCashFn.mockResolvedValue({
    withPaymentRecord: rows,
    appliedRecords: [],
    offControl,
    postedThrough,
  });
}

beforeEach(() => {
  sqlFn.mockReset();
  paymentCashFn.mockReset();
});

describe('getUnappliedControlCash — AR', () => {
  it('finds a receipt with a payment row and NO allocations (B2)', async () => {
    mockBasis([payment()]);
    sqlFn.mockResolvedValueOnce([]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(paymentCashFn).toHaveBeenCalledWith(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord).toEqual([
      expect.objectContaining({ id: 'p1', documentNumber: 'CP-2026-00001', amount: 172500 }),
    ]);
    expect(res.total).toBe(172500);
  });

  it('reports only the UNALLOCATED remainder of a partly applied receipt', async () => {
    mockBasis([payment({ id: 'p2', amount: 60000, documentUnapplied: 60000, gross: 100000 })]);
    sqlFn.mockResolvedValueOnce([]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord[0]!.amount).toBe(60000);
  });

  it('finds control-account movement with NO subledger document at all (B24)', async () => {
    mockBasis([]);
    sqlFn
      .mockResolvedValueOnce([
        { id: 'je9', document_number: 'JE-2026-00990', entity_name: null,
          document_date: '2026-03-25', control_credit: '51750',
          created_at: '2026-03-25T06:00:00.000Z' },
      ]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withoutPaymentRecord).toEqual([
      expect.objectContaining({ id: 'je9', documentNumber: 'JE-2026-00990', amount: 51750 }),
    ]);
    expect(res.total).toBe(51750);
    // The two mechanisms are reported apart: the remedy differs, and one of them
    // is invisible to every other tool in the programme.
    expect(res.withPaymentRecord).toEqual([]);
  });

  it('totals BOTH mechanisms — seeing only one is the failure mode', async () => {
    mockBasis(
      [payment({ id: 'p1', documentNumber: 'CP-1', documentDate: '2026-01-01',
                 amount: 1000, documentUnapplied: 1000, gross: 1000 })],
      '2026-01-01T00:00:00.000Z',
    );
    sqlFn
      .mockResolvedValueOnce([
        { id: 'je1', document_number: 'JE-1', entity_name: null, document_date: '2026-01-02',
          control_credit: '250', created_at: '2026-01-02T00:00:00.000Z' },
      ]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.total).toBe(1250);
    expect(res.postedThrough).toBe('2026-01-02T00:00:00.000Z');
  });

  it('drops a fully applied receipt rather than reporting a zero item', async () => {
    // The shared basis never returns one: a payment with nothing left to apply
    // is not unapplied cash.
    mockBasis([]);
    sqlFn.mockResolvedValueOnce([]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.appliedRecords).toEqual([]);
  });

  it('returns nothing at all when no control account was resolved', async () => {
    // With no control account there is nothing to be unapplied AGAINST, and
    // running the query with an empty array would scan the whole ledger.
    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', []);
    expect(res).toMatchObject({ total: 0, withPaymentRecord: [], withoutPaymentRecord: [], appliedRecords: [] });
    expect(sqlFn).not.toHaveBeenCalled();
    expect(paymentCashFn).not.toHaveBeenCalled();
  });

  it('carries the gross of the document behind every item', async () => {
    // The invariant `|amount| <= cited gross` can only be checked if each item
    // knows what it cites. A payment's gross is its total; a bare journal's is
    // its own movement on the control account.
    mockBasis([payment({ amount: 100000, documentUnapplied: 100000, gross: 172500 })]);
    sqlFn.mockResolvedValueOnce([
      { id: 'je9', document_number: 'JE-9', entity_name: null, document_date: '2026-03-25',
        control_credit: '-51750', created_at: '2026-03-25T06:00:00.000Z' },
    ]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord[0]).toMatchObject({ amount: 100000, gross: 172500 });
    expect(res.withoutPaymentRecord[0]).toMatchObject({ amount: -51750, gross: 51750 });
  });

  it('scopes every query by company and passes the date as a string', async () => {
    mockBasis([]);
    sqlFn.mockResolvedValueOnce([]);
    await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    for (const call of sqlFn.mock.calls) {
      const values = call.slice(1);
      expect(values).toContain(COMPANY);
      expect(values).toContain('2026-09-03');
      expect(values.every((v: unknown) => !(v instanceof Date))).toBe(true);
    }
  });
});
