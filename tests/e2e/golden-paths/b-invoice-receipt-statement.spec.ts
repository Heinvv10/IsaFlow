/**
 * Golden path (b): invoice → post → receipt → allocate → customer statement.
 *
 * Known-good at baseline (July-4 audit: AR PASS) — pins the core AR money path.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('customer invoice: create → approve → receipt allocation → statement', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    // Fixture customer (find-or-create '0GP-Golden-Customer'): seeded Demo
    // masters carry non-RFC UUIDs that zod-strict endpoints 422 on (N1), and
    // creating a fresh master per run grew the shared books unboundedly.
    const clientId = await api.fixtureCustomer();
    expect(clientId).toBeTruthy();

    // Create draft invoice (100.00 + 15% VAT = 115.00).
    const ref = gpRef('INV');
    const created = await api.post<any>('/api/accounting/customer-invoices-create', {
      clientId,
      invoiceDate: today(),
      dueDate: today(),
      taxRate: 15,
      notes: ref,
      items: [{ description: ref, quantity: 1, unitPrice: 100 }],
    });
    const invoiceId = created.id ?? created.invoiceId;
    expect(invoiceId).toBeTruthy();

    // Approve → posts to GL.
    await api.post('/api/accounting/customer-invoices-detail', {
      id: invoiceId,
      action: 'approve',
    });
    const approved = await api.get<any>(
      `/api/accounting/customer-invoices-detail?id=${invoiceId}`,
    );
    expect(['approved', 'sent']).toContain(approved.status);
    expect(approved.gl_journal_entry_id, 'approval must post a GL journal').toBeTruthy();
    expect(Number(approved.total_amount)).toBeCloseTo(115, 2);

    // Double-entry assertion (blind-review MEDIUM): the approval journal must
    // actually carry DR 115 / CR 115 across its lines — not merely exist.
    const journal = await api.get<any>(
      `/api/accounting/journal-entries-detail?id=${approved.gl_journal_entry_id}`,
    );
    expect(journal.status).toBe('posted');
    const drTotal = journal.lines.reduce((t: number, l: any) => t + Number(l.debit), 0);
    const crTotal = journal.lines.reduce((t: number, l: any) => t + Number(l.credit), 0);
    expect(drTotal).toBeCloseTo(115, 2);
    expect(crTotal).toBeCloseTo(115, 2);

    // Receipt allocated to the invoice.
    const payment = await api.post<any>('/api/accounting/customer-payments', {
      clientId,
      paymentDate: today(),
      totalAmount: 115,
      paymentMethod: 'eft',
      description: gpRef('RCPT'),
      allocations: [{ invoiceId, amount: 115 }],
    });
    expect(payment).toBeTruthy();

    // Payments are created as drafts; allocations hit the invoice on confirm.
    await api.post('/api/accounting/customer-payments-action', {
      action: 'confirm',
      paymentId: payment.id,
    });

    // Invoice reflects the payment.
    const paid = await api.get<any>(`/api/accounting/customer-invoices-detail?id=${invoiceId}`);
    expect(Number(paid.amount_paid)).toBeCloseTo(115, 2);

    // Customer statement includes both documents.
    const stmt = await api.get<any>(
      `/api/accounting/customer-statement?customerId=${clientId}&fromDate=${today()}&toDate=${today()}`,
    );
    const stmtText = JSON.stringify(stmt);
    expect(stmtText, 'statement must include the invoice').toContain(String(approved.invoice_number));
  } finally {
    await api.dispose();
  }
});
