/**
 * Subledger snapshots (W2) — the row-level view the aging reports and
 * `reconcile_subledger` share, so there is ONE answer to "what is open".
 *
 * The defect this replaces: `getARAging` carried `AND ci.due_date IS NOT NULL`
 * in its WHERE clause, so a R1,058,000 invoice with a null due date vanished
 * from the report with no error and no count — R1,058,000 of a R1,429,774
 * reconciling difference was that one row. NULL is data. A document that
 * cannot be aged is excluded from the BUCKETS and reported by name; it is
 * never dropped from the subledger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlFn(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/disputeService', () => ({
  getOpenDisputeTotals: vi.fn().mockResolvedValue(new Map()),
}));

import { getARSubledger } from '@/modules/accounting/services/ar/arSubledgerService';
import { getAPSubledger } from '@/modules/accounting/services/ap/apSubledgerService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

function inv(over: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    document_number: 'INV0000001',
    entity_id: 'cccccccc-0000-4000-8000-000000000001',
    entity_name: 'Blitz Fibre',
    document_date: '2026-01-10',
    due_date: '2026-02-10',
    total_amount: '1000',
    amount_paid: '0',
    balance: '1000',
    created_at: '2026-01-10T08:00:00.000Z',
    ...over,
  };
}

beforeEach(() => sqlFn.mockReset());

describe('getARSubledger', () => {
  it('KEEPS a null-due-date invoice in the subledger and marks it unageable', async () => {
    sqlFn
      .mockResolvedValueOnce([
        inv(),
        inv({ id: 'aaaaaaaa-0000-4000-8000-000000000002', document_number: 'INV0000133',
              due_date: null, total_amount: '1058000', balance: '1058000' }),
      ])
      .mockResolvedValueOnce([]); // credit notes

    const snap = await getARSubledger(COMPANY, '2026-09-03');

    expect(snap.documents).toHaveLength(2);
    expect(snap.subledgerTotal).toBe(1059000);
    expect(snap.unageable).toHaveLength(1);
    expect(snap.unageable[0]).toMatchObject({ documentNumber: 'INV0000133', balance: 1058000 });
    // ...and it is NOT in the ageable set, because it cannot be bucketed.
    expect(snap.ageable.map((d) => d.documentNumber)).toEqual(['INV0000001']);
  });

  it('flags a document dated AFTER the reporting date without dropping it', async () => {
    // The subledger counts it; the control account cannot, because its journal
    // is dated after as_at. That gap is a reconciling item, not an error.
    sqlFn
      .mockResolvedValueOnce([
        inv({ document_date: '2026-10-01', due_date: '2026-11-01', total_amount: '51750', balance: '51750' }),
      ])
      .mockResolvedValueOnce([]);

    const snap = await getARSubledger(COMPANY, '2026-09-03');
    expect(snap.afterAsAt).toHaveLength(1);
    expect(snap.afterAsAt[0]!.balance).toBe(51750);
    expect(snap.subledgerTotal).toBe(51750);
  });

  it('carries an unallocated credit note as a NEGATIVE balance', async () => {
    sqlFn
      .mockResolvedValueOnce([inv()])
      .mockResolvedValueOnce([
        inv({ id: 'bbbbbbbb-0000-4000-8000-000000000001', document_number: 'CN0001',
              total_amount: '250', balance: '250' }),
      ]);

    const snap = await getARSubledger(COMPANY, '2026-09-03');
    expect(snap.creditNotes[0]!.balance).toBe(-250);
    expect(snap.subledgerTotal).toBe(750);
  });

  it('reports posted_through as the latest write it consumed, never now()', async () => {
    sqlFn
      .mockResolvedValueOnce([
        inv({ created_at: '2026-01-10T08:00:00.000Z' }),
        inv({ id: 'aaaaaaaa-0000-4000-8000-000000000003', created_at: '2026-08-31T22:15:00.000Z' }),
      ])
      .mockResolvedValueOnce([]);

    const snap = await getARSubledger(COMPANY, '2026-09-03');
    expect(snap.postedThrough).toBe('2026-08-31T22:15:00.000Z');
  });

  it('returns a null posted_through on an empty subledger rather than a timestamp', async () => {
    sqlFn.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const snap = await getARSubledger(COMPANY, '2026-09-03');
    expect(snap.postedThrough).toBeNull();
    expect(snap.subledgerTotal).toBe(0);
  });

  it('scopes by the company it was given', async () => {
    sqlFn.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await getARSubledger(COMPANY, '2026-09-03');
    for (const call of sqlFn.mock.calls) expect(call.slice(1)).toContain(COMPANY);
  });
});

describe('getAPSubledger', () => {
  it('keeps a null-due-date supplier invoice and marks it unageable', async () => {
    sqlFn.mockResolvedValueOnce([
      inv({ document_number: 'BILL-1' }),
      inv({ id: 'aaaaaaaa-0000-4000-8000-000000000009', document_number: 'BILL-2', due_date: null }),
    ]);

    const snap = await getAPSubledger(COMPANY, '2026-09-03');
    expect(snap.documents).toHaveLength(2);
    expect(snap.unageable.map((d) => d.documentNumber)).toEqual(['BILL-2']);
    expect(snap.subledgerTotal).toBe(2000);
    // AP has no credit-note leg in this schema; the field exists and is empty.
    expect(snap.creditNotes).toEqual([]);
  });
});
