/**
 * Golden path (c): invoice → cancel → GL reversal exists.
 *
 * Was EXPECTED FAIL at baseline (July-4 audit C1: cancel was a status flip
 * only — Britech INV0000134 / R28,750; Demo JE-2026-00927 / R1,725).
 * Flipped to a plain test by the P1.1 fix (customerInvoiceCancelService).
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('cancelling a posted invoice reverses its GL journal', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    const customers = await api.get<any[]>('/api/accounting/customers?limit=1');
    const clientId = customers[0].id;

    // Create + approve an invoice so a GL journal exists.
    const ref = gpRef('CXL');
    const created = await api.post<any>('/api/accounting/customer-invoices-create', {
      clientId,
      invoiceDate: today(),
      dueDate: today(),
      taxRate: 15,
      notes: ref,
      items: [{ description: ref, quantity: 1, unitPrice: 100 }],
    });
    const invoiceId = created.id ?? created.invoiceId;

    await api.post('/api/accounting/customer-invoices-detail', {
      id: invoiceId,
      action: 'approve',
    });
    const approved = await api.get<any>(
      `/api/accounting/customer-invoices-detail?id=${invoiceId}`,
    );
    const glEntryId = approved.gl_journal_entry_id;
    expect(glEntryId, 'approval must post a GL journal').toBeTruthy();

    // Cancel the posted invoice.
    await api.post('/api/accounting/customer-invoices-detail', {
      id: invoiceId,
      action: 'cancel',
    });
    const cancelled = await api.get<any>(
      `/api/accounting/customer-invoices-detail?id=${invoiceId}`,
    );
    expect(cancelled.status).toBe('cancelled');

    // CORRECT behavior: the approval journal must be reversed so the books
    // no longer carry the cancelled invoice's AR/Revenue/VAT.
    const journal = await api.get<any>(
      `/api/accounting/journal-entries-detail?id=${glEntryId}`,
    );
    expect(
      journal.status,
      'cancel must reverse the approval journal (status → reversed)',
    ).toBe('reversed');
  } finally {
    await api.dispose();
  }
});
