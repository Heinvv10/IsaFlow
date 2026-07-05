/**
 * Golden path (e): credit note → approve → apply to invoice.
 *
 * EXPECTED FAIL at baseline — July-4 audit H3: approveCreditNote does
 * String(cn.credit_date) on a pg Date → Postgres gets a JS toString like
 * "…GMT+0200 (South Africa Standard Time)" → `time zone "gmt+0200" not
 * recognized` → credit notes can never leave draft. Fixed by P1.4 (fmtDate).
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('credit note: create → approve → apply to invoice', async ({ baseURL }) => {
  test.fail(true, 'AUDIT H3 (2026-07-04): approve throws timezone SQL error — fixed by P1.4');

  const api = await Api.login(baseURL!);
  try {
    const customers = await api.get<any[]>('/api/accounting/customers?limit=1');
    const clientId = customers[0].id;

    // Target invoice for the credit (create + approve so it carries a balance).
    const ref = gpRef('CNI');
    const created = await api.post<any>('/api/accounting/customer-invoices-create', {
      clientId,
      invoiceDate: today(),
      dueDate: today(),
      taxRate: 15,
      notes: ref,
      items: [{ description: ref, quantity: 1, unitPrice: 200 }],
    });
    const invoiceId = created.id ?? created.invoiceId;
    await api.post('/api/accounting/customer-invoices-detail', {
      id: invoiceId,
      action: 'approve',
    });

    // Create the credit note (draft) — 100.00 + 15% VAT.
    const cn = await api.post<any>('/api/accounting/credit-notes', {
      type: 'customer',
      clientId,
      customerInvoiceId: invoiceId,
      creditDate: today(),
      reason: gpRef('CN'),
      subtotal: 100,
      taxRate: 15,
    });
    const creditNoteId = cn.id;
    expect(creditNoteId).toBeTruthy();

    // Approve — the step that dies on the date bug today.
    await api.post('/api/accounting/credit-notes-action', {
      action: 'approve',
      creditNoteId,
    });

    // Apply to the invoice.
    await api.post('/api/accounting/credit-notes-action', {
      action: 'apply',
      creditNoteId,
      invoiceId,
    });

    // Invoice balance reduced by the credit total (115.00 of 230.00).
    const after = await api.get<any>(
      `/api/accounting/customer-invoices-detail?id=${invoiceId}`,
    );
    const balance = Number(after.total_amount) - Number(after.amount_paid);
    expect(balance).toBeCloseTo(115, 2);
  } finally {
    await api.dispose();
  }
});
