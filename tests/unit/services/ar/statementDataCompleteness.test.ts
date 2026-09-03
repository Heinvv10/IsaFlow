/**
 * What a customer statement is allowed to leave out.
 *
 * `fetchStatementData` is a real builder whose only consumer was the emailed
 * statement. Two of its filters drop rows silently, and one of them is wrong:
 *
 *   - credit notes were filtered to `status = 'approved'`. A credit note that
 *     has been applied to an invoice lands in `'applied'`, not `'approved'` —
 *     so EVERY applied credit note was invisible on the statement, and the
 *     running balance overstated what the customer owed by the full value of
 *     them. There are 92 of them on the demo books, R372,519.32 worth, and
 *     none had ever appeared on a statement.
 *
 *   - payments are filtered to confirmed/reconciled, which is correct — a
 *     draft receipt has not settled anything — but dropping it in silence is
 *     the defect. It goes in excludedRows with its amount, so a reader can see
 *     "this customer has paid you R50,000 that nobody has confirmed".
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
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/statementEmailTemplate', () => ({
  buildStatementEmailHtml: vi.fn(() => ''),
}));
vi.mock('@/lib/email-templates', () => ({ appendSignatureToHtml: vi.fn((h: string) => h) }));

import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CUSTOMER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const CUST = [{ id: CUSTOMER, name: 'Blitz Fibre', email: 'ap@blitz.example' }];
const INVOICES = [
  { id: 'i1', invoice_number: 'INV0001', invoice_date: '2026-01-15', total_amount: 10000 },
  { id: 'i2', invoice_number: 'INV0002', invoice_date: '2026-02-15', total_amount: 5000 },
];
const PAYMENTS = [
  { id: 'p1', payment_number: 'PMT0001', payment_date: '2026-02-01', amount_allocated: 4000, status: 'confirmed' },
];
const CREDITS = [
  { id: 'c1', credit_note_number: 'CN0001', credit_date: '2026-02-20', total_amount: 1500, status: 'applied' },
];

function routeMock(over: Record<string, unknown[]> = {}) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    if (q.includes('FROM customers')) return Promise.resolve(over.customer ?? CUST);
    if (q.includes('FROM customer_invoices')) return Promise.resolve(over.invoices ?? INVOICES);
    if (q.includes('FROM customer_payments')) return Promise.resolve(over.payments ?? PAYMENTS);
    if (q.includes('FROM credit_notes')) return Promise.resolve(over.credits ?? CREDITS);
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('fetchStatementData — applied credit notes belong on the statement', () => {
  it('does not filter credit notes to one status in SQL — the classifier decides', async () => {
    routeMock();
    await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31');
    const q = sqlCalls.find((c) => c.sql.includes('FROM credit_notes'))!;
    // `status = 'approved'` in the WHERE clause is the bug: it removed every
    // applied note before anything could report it. The query must hand every
    // candidate row to the classifier, which includes the live ones and names
    // the rest in `excluded`.
    expect(q.sql).not.toMatch(/status\s*=/);
  });

  it('credits the customer with the applied note, so the balance is not overstated', async () => {
    routeMock();
    const payload = (await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31'))!;
    // 15,000 invoiced − 4,000 paid − 1,500 credited = 9,500.
    expect(payload.summary.totalCredits).toBeCloseTo(1500, 2);
    expect(payload.summary.balance).toBeCloseTo(9500, 2);
  });
});

describe('fetchStatementData — what it drops, it names', () => {
  it('reports an unconfirmed payment in excluded, with its amount', async () => {
    routeMock({
      payments: [
        ...PAYMENTS,
        { id: 'p2', payment_number: 'PMT0002', payment_date: '2026-03-01', amount_allocated: 50000, status: 'draft' },
      ],
    });
    const payload = (await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31'))!;
    const excluded = payload.excluded.find((e) => e.id === 'p2');

    expect(excluded).toBeDefined();
    expect(excluded!.reason).toBe('payment_not_confirmed');
    // "One payment was excluded" and "R50,000 was excluded" are different
    // facts, and only the second tells a reader whether to care.
    expect(excluded!.amount).toBeCloseTo(50000, 2);
    // And it must NOT have reduced the balance.
    expect(payload.summary.balance).toBeCloseTo(9500, 2);
  });

  it('accounts for every candidate row: included plus excluded equals the universe', async () => {
    routeMock({
      payments: [
        ...PAYMENTS,
        { id: 'p2', payment_number: 'PMT0002', payment_date: '2026-03-01', amount_allocated: 50000, status: 'cancelled' },
      ],
    });
    const payload = (await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31'))!;
    expect(payload.transactions.length + payload.excluded.length).toBe(payload.universeTotal);
  });

  it('reports the period it actually covers, not a rolling year it does not', async () => {
    // fromDate was `Date.now() − 365 days` while the invoice query had no lower
    // bound at all, so the emailed statement claimed a window it did not use —
    // and computed it through toISOString(), which rolls back a day on a UTC+2
    // host.
    routeMock();
    const payload = (await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31'))!;
    expect(payload.fromDate).toBe('2026-01-15');
    expect(payload.toDate).toBe('2026-03-31');
  });

  it('returns null for a customer in another company', async () => {
    routeMock({ customer: [] });
    expect(await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31')).toBeNull();
  });

  it('scopes every query by company', async () => {
    routeMock();
    await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31');
    for (const table of ['FROM customers', 'FROM customer_invoices', 'FROM customer_payments', 'FROM credit_notes']) {
      const q = sqlCalls.find((c) => c.sql.includes(table));
      expect(q, table).toBeDefined();
      expect(q!.values, table).toContain(COMPANY);
    }
  });
});
