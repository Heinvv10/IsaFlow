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
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlFn(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getUnappliedControlCash } from '@/modules/accounting/services/reconciliation/unappliedCashService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CTRL = ['22222222-2222-4222-8222-222222222222'];

beforeEach(() => sqlFn.mockReset());

describe('getUnappliedControlCash — AR', () => {
  it('finds a receipt with a payment row and NO allocations (B2)', async () => {
    sqlFn
      .mockResolvedValueOnce([
        { id: 'p1', document_number: 'CP-2026-00001', entity_name: 'Velocity Fibre',
          document_date: '2026-07-24', control_credit: '172500', allocated: '0',
          created_at: '2026-07-24T10:00:00.000Z' },
      ])
      .mockResolvedValueOnce([]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord).toEqual([
      expect.objectContaining({ id: 'p1', documentNumber: 'CP-2026-00001', amount: 172500 }),
    ]);
    expect(res.total).toBe(172500);
  });

  it('reports only the UNALLOCATED remainder of a partly applied receipt', async () => {
    sqlFn
      .mockResolvedValueOnce([
        { id: 'p2', document_number: 'CP-2', entity_name: 'X', document_date: '2026-05-01',
          control_credit: '100000', allocated: '40000', created_at: '2026-05-01T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord[0]!.amount).toBe(60000);
    // ...and the applied R40,000 is still reported, on its own line. It moved
    // the control account too, and a partition that omits it leaves exactly
    // that much in `unexplained_difference`.
    expect(res.appliedRecords[0]!.amount).toBe(40000);
  });

  it('finds control-account movement with NO subledger document at all (B24)', async () => {
    sqlFn
      .mockResolvedValueOnce([])
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
    sqlFn
      .mockResolvedValueOnce([
        { id: 'p1', document_number: 'CP-1', entity_name: 'A', document_date: '2026-01-01',
          control_credit: '1000', allocated: '0', created_at: '2026-01-01T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([
        { id: 'je1', document_number: 'JE-1', entity_name: null, document_date: '2026-01-02',
          control_credit: '250', created_at: '2026-01-02T00:00:00.000Z' },
      ]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.total).toBe(1250);
    expect(res.postedThrough).toBe('2026-01-02T00:00:00.000Z');
  });

  it('drops a fully applied receipt rather than reporting a zero item', async () => {
    sqlFn
      .mockResolvedValueOnce([
        { id: 'p3', document_number: 'CP-3', entity_name: 'A', document_date: '2026-01-01',
          control_credit: '500', allocated: '500', created_at: '2026-01-01T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([]);

    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(res.withPaymentRecord).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.appliedRecords[0]!.amount).toBe(500);
  });

  it('returns nothing at all when no control account was resolved', async () => {
    // With no control account there is nothing to be unapplied AGAINST, and
    // running the query with an empty array would scan the whole ledger.
    const res = await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', []);
    expect(res).toMatchObject({ total: 0, withPaymentRecord: [], withoutPaymentRecord: [], appliedRecords: [] });
    expect(sqlFn).not.toHaveBeenCalled();
  });

  it('scopes every query by company and passes the date as a string', async () => {
    sqlFn.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await getUnappliedControlCash(COMPANY, 'ar', '2026-09-03', CTRL);
    for (const call of sqlFn.mock.calls) {
      const values = call.slice(1);
      expect(values).toContain(COMPANY);
      expect(values).toContain('2026-09-03');
      expect(values.every((v: unknown) => !(v instanceof Date))).toBe(true);
    }
  });
});
