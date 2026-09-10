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

const rows: unknown[][] = [];
/**
 * The readers splice the settlement rewind in as a NESTED `sql` fragment, so
 * `sql` is called several times per query and only the last call is the
 * statement. Queuing responses positionally would hand the invoice rows to a
 * rewind fragment and leave every assertion green against an empty result.
 *
 * A fragment is discriminated by having no ORDER BY: every top-level statement
 * here orders its rows, and no fragment does.
 */
const sqlFn = vi.fn((...a: unknown[]) => {
  const parts = a[0];
  const text = Array.isArray(parts) ? parts.join('?') : '';
  if (!text.includes('ORDER BY')) return { fragment: text };
  return Promise.resolve(rows.shift() ?? []);
});
/** The statement as Postgres would see it: template text plus its values. */
function render(call: readonly unknown[]): string {
  const parts = call[0];
  if (!Array.isArray(parts)) return '';
  return (parts as string[])
    .map((part, i) => part + (i < call.length - 1 ? String(call[i + 1] ?? '') : ''))
    .join('');
}

/** Queue one statement's result. */
function nextRows(...results: unknown[][]) {
  rows.push(...results);
}
vi.mock('@/lib/neon', () => ({
  // `unsafe` is part of the real client: the point-in-time rewind splices a
  // nested fragment and an interpolated expression through it. A mock without
  // it fails loudly, which is better than a mock that silently drops the
  // rewind and leaves every assertion green against today's balances.
  sql: Object.assign((...a: unknown[]) => sqlFn(...a), { unsafe: (t: string) => t }),
  withTransaction: vi.fn(),
}));
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

beforeEach(() => {
  rows.length = 0;
  sqlFn.mockClear();
});

describe('getARSubledger', () => {
  it('KEEPS a null-due-date invoice in the subledger and marks it unageable', async () => {
    nextRows(
      [
        inv(),
        inv({ id: 'aaaaaaaa-0000-4000-8000-000000000002', document_number: 'INV0000133',
              due_date: null, total_amount: '1058000', balance: '1058000' }),
      ],
      [], // credit notes
    );

    const snap = await getARSubledger(COMPANY, '2026-09-03');

    expect(snap.documents).toHaveLength(2);
    expect(snap.subledgerTotal).toBe(1059000);
    expect(snap.unageable).toHaveLength(1);
    expect(snap.unageable[0]).toMatchObject({ documentNumber: 'INV0000133', balance: 1058000 });
    // ...and it is NOT in the ageable set, because it cannot be bucketed.
    expect(snap.ageable.map((d) => d.documentNumber)).toEqual(['INV0000001']);
  });

  it('applies the as-at cutoff and the rewind IN SQL, not in TypeScript', async () => {
    // Both were the defect. `amount_paid` is a current snapshot, so reading it
    // froze `subledgerTotal` at today's figure while the control-account
    // balance moved with the date; and with no document-date cutoff an invoice
    // raised after the reporting date was counted as owed on it. On production
    // at 2025-12-31 the two together produced a Velocity AR difference of
    // R81,996,370.82 that closed only via a R72,867,375.59
    // `document_after_as_at` item.
    //
    // This asserts the SQL, because there is nothing left to assert in
    // TypeScript: filtering here as well would be a second definition of one
    // boundary. A DB-gated test proves the statement runs and ties to the aged
    // report — see subledgerTiesToAging.integration.test.ts.
    nextRows([inv()], []);
    await getARSubledger(COMPANY, '2026-06-30');

    // Rendered WITH the interpolated values: `effectivePaidExpr` arrives
    // through `sql.unsafe` as an argument, not as template text, so joining
    // the strings alone would assert on a query with the rewind cut out of it.
    const statements = sqlFn.mock.calls.map(render).filter((t) => t.includes('ORDER BY'));
    const invoiceQuery = statements.find((t) => t.includes('FROM customer_invoices'))!;
    expect(invoiceQuery).toContain('COALESCE(ci.invoice_date, ci.created_at::date) <=');
    // The rewound balance, not amount_paid, and on the same population the
    // aging report uses — settled-today invoices included.
    expect(invoiceQuery).toContain('LEAST(GREATEST(COALESCE(ci.amount_paid, 0)');
    expect(invoiceQuery).toContain('unpaid.amount');
    // COALESCE, not the bare form: status is nullable and NULL NOT IN (...) is
    // NULL, so the bare spelling selected a NARROWER population than the ageing
    // — and reconcile_subledger then books the difference as an unexplained
    // residual. Pinned by outcome in r059-subledger-population-equals-ageing.
    expect(invoiceQuery).toContain("COALESCE(ci.status, '') NOT IN ('draft', 'cancelled')");
    // A credit note granted later had not reduced the balance then.
    const creditQuery = statements.find((t) => t.includes('FROM credit_notes'))!;
    expect(creditQuery).toContain('cn.credit_date <=');
  });

  it('carries an unallocated credit note as a NEGATIVE balance', async () => {
    nextRows(
      [inv()],
      [
        inv({ id: 'bbbbbbbb-0000-4000-8000-000000000001', document_number: 'CN0001',
              total_amount: '250', balance: '250' }),
      ],
    );

    const snap = await getARSubledger(COMPANY, '2026-09-03');
    expect(snap.creditNotes[0]!.balance).toBe(-250);
    expect(snap.subledgerTotal).toBe(750);
  });

  it('reports posted_through as the latest write it consumed, never now()', async () => {
    nextRows(
      [
        inv({ created_at: '2026-01-10T08:00:00.000Z' }),
        inv({ id: 'aaaaaaaa-0000-4000-8000-000000000003', created_at: '2026-08-31T22:15:00.000Z' }),
      ],
      [],
    );

    const snap = await getARSubledger(COMPANY, '2026-09-03');
    expect(snap.postedThrough).toBe('2026-08-31T22:15:00.000Z');
  });

  it('returns a null posted_through on an empty subledger rather than a timestamp', async () => {
    nextRows([], []);
    const snap = await getARSubledger(COMPANY, '2026-09-03');
    expect(snap.postedThrough).toBeNull();
    expect(snap.subledgerTotal).toBe(0);
  });

  it('scopes by the company it was given', async () => {
    nextRows([], []);
    await getARSubledger(COMPANY, '2026-09-03');
    // Every statement or fragment that FILTERS on a tenant carries the id it
    // was given. The rewind's outer wrapper filters nothing — it only splices
    // its own sub-fragments together — so requiring the id there would assert
    // a scope that has no column to apply it to.
    const scoped = sqlFn.mock.calls.filter((c) => render(c).includes('company_id'));
    expect(scoped.length).toBeGreaterThanOrEqual(4);
    for (const call of scoped) expect(call.slice(1)).toContain(COMPANY);
  });
});

describe('getAPSubledger', () => {
  it('keeps a null-due-date supplier invoice and marks it unageable', async () => {
    nextRows([
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
