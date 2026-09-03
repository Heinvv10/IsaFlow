/**
 * The supplier statement — the mirror of the customer one, and it has to stay
 * a mirror.
 *
 * Two rules are carried across deliberately, because a supplier statement that
 * disagreed with the customer statement about what counts would be worse than
 * having none:
 *
 *   - a credit note counts whether it is 'approved' or 'applied'. Filtering to
 *     'approved' alone is what hid every applied customer credit note from
 *     every statement ever sent.
 *   - a payment that has not been processed does not settle anything, but it is
 *     NAMED with its amount rather than dropped. There are 56 draft supplier
 *     payments on these books.
 *
 * And the sign runs the other way: this is a payable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUPPLIER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const SUPP = [{ id: SUPPLIER, name: 'Fibre Supplies CC', email: 'ar@fibre.example' }];
const INVOICES = [
  { id: 'i1', invoice_number: 'SI0001', invoice_date: '2026-01-10', total_amount: 20000, status: 'approved', created_at: '2026-01-10T08:00:00Z' },
];
const PAYMENTS = [
  { id: 'p1', payment_number: 'SP0001', payment_date: '2026-02-05', amount_allocated: 8000, status: 'processed', created_at: '2026-02-05T08:00:00Z' },
];
// applied_amount DIFFERS from total_amount on purpose: approving a note applies
// MIN(total, outstanding) and strands the excess. A fixture where the two agree
// cannot tell a statement that reads the applied figure from one that reads the
// face value — and the face value OVERSTATES what we still owe the supplier.
const CREDITS = [
  { id: 'c1', credit_note_number: 'SCN0001', credit_date: '2026-02-20', total_amount: 2000, applied_amount: 1200, status: 'applied', created_at: '2026-02-20T08:00:00Z' },
];

function routeMock(over: Record<string, unknown[]> = {}) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    if (q.includes('FROM suppliers')) return Promise.resolve(over.supplier ?? SUPP);
    if (q.includes('FROM supplier_invoices')) return Promise.resolve(over.invoices ?? INVOICES);
    if (q.includes('FROM supplier_payments')) return Promise.resolve(over.payments ?? PAYMENTS);
    if (q.includes('FROM credit_notes')) return Promise.resolve(over.credits ?? CREDITS);
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('fetchSupplierStatementData — a payable runs the other way', () => {
  it('an invoice increases what we owe and a payment reduces it', async () => {
    routeMock();
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    // 20,000 billed − 8,000 paid − 2,000 credited = 10,000 still owed.
    expect(p.summary.totalInvoiced).toBeCloseTo(20000, 2);
    expect(p.summary.totalPaid).toBeCloseTo(8000, 2);
    // The note's face value is 2,000 but only 1,200 was ever applied.
    expect(p.summary.totalCredits).toBeCloseTo(1200, 2);
    expect(p.summary.balance).toBeCloseTo(10800, 2);
  });

  it('the running balance is positive while we still owe money', async () => {
    routeMock();
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    expect(p.transactions[0]!.balance).toBeCloseTo(20000, 2);
    expect(p.transactions[p.transactions.length - 1]!.balance).toBeCloseTo(10800, 2);
  });

  it('counts an APPLIED supplier credit note, not only an approved one', async () => {
    routeMock();
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    expect(p.transactions.some((t) => t.type === 'credit_note')).toBe(true);
    // And the query must not have removed it before the classifier saw it.
    const q = sqlCalls.find((c) => c.sql.includes('FROM credit_notes'))!;
    expect(q.sql).not.toMatch(/status\s*=/);
  });
});

describe('fetchSupplierStatementData — what it drops, it names', () => {
  it('reports an unprocessed payment in excluded, with its amount', async () => {
    routeMock({
      payments: [
        ...PAYMENTS,
        { id: 'p2', payment_number: 'SP0002', payment_date: '2026-03-01', amount_allocated: 5000, status: 'draft', created_at: '2026-03-01T08:00:00Z' },
      ],
    });
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    const ex = p.excluded.find((e) => e.id === 'p2')!;

    expect(ex.reason).toBe('payment_not_processed');
    expect(ex.amount).toBeCloseTo(5000, 2);
    // A draft payment must not have reduced what we owe.
    expect(p.summary.balance).toBeCloseTo(10800, 2);
  });

  it('accounts for every candidate row', async () => {
    routeMock({
      payments: [
        ...PAYMENTS,
        { id: 'p2', payment_number: 'SP0002', payment_date: '2026-03-01', amount_allocated: 5000, status: 'cancelled', created_at: '2026-03-01T08:00:00Z' },
      ],
    });
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    expect(p.transactions.length + p.excluded.length).toBe(p.universeTotal);
  });

  it('reports the window it actually covers', async () => {
    routeMock();
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    expect(p.fromDate).toBe('2026-01-10');
    expect(p.toDate).toBe('2026-03-31');
  });

  it('pins posted_through to the latest document consumed, never now()', async () => {
    routeMock();
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    expect(p.postedThrough).toBe('2026-02-20T08:00:00.000Z');
  });

  it('returns null for a supplier in another company', async () => {
    routeMock({ supplier: [] });
    expect(await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31')).toBeNull();
  });

  it('scopes every query by company', async () => {
    routeMock();
    await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31');
    for (const table of ['FROM suppliers', 'FROM supplier_invoices', 'FROM supplier_payments', 'FROM credit_notes']) {
      const q = sqlCalls.find((c) => c.sql.includes(table));
      expect(q, table).toBeDefined();
      expect(q!.values, table).toContain(COMPANY);
    }
  });
});

describe('supplier statement — a partly-applied credit note debits what was applied', () => {
  it('debits applied_amount, not the face value, once a note is applied', async () => {
    routeMock();
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    const cn = p.transactions.find(t => t.type === 'credit_note')!;
    // R1,200 came off what we owe; the other R800 is stranded — a note at
    // 'applied' cannot be applied again. Debiting 2,000 understates the
    // liability to the supplier.
    expect(cn.debit).toBeCloseTo(1200, 2);
    expect(p.summary.totalCredits).toBeCloseTo(1200, 2);
  });

  it('debits the face value of an approved note, which has nothing applied yet', async () => {
    routeMock({
      credits: [
        { id: 'c2', credit_note_number: 'SCN0002', credit_date: '2026-02-20', total_amount: 2000, applied_amount: 0, status: 'approved', created_at: '2026-02-20T08:00:00Z' },
      ],
    });
    const p = (await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31'))!;
    const cn = p.transactions.find(t => t.type === 'credit_note')!;
    expect(cn.debit).toBeCloseTo(2000, 2);
  });

  it('asks the database for applied_amount at all', async () => {
    routeMock();
    await fetchSupplierStatementData(COMPANY, SUPPLIER, '2026-03-31');
    const q = sqlCalls.find((c) => c.sql.includes('FROM credit_notes'))!;
    expect(q.sql).toContain('applied_amount');
  });
});
