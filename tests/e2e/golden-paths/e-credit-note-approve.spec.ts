/**
 * Golden path (e): credit note → approve → apply to invoice.
 *
 * Was EXPECTED FAIL at baseline — July-4 audit H3: approveCreditNote did
 * String(cn.credit_date) on a pg Date → `time zone "gmt+0200" not
 * recognized` → credit notes could never leave draft. Flipped to a plain
 * test by P1.4's date fix (PR #193, creditNoteService serialization).
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('credit note: create → approve → apply to invoice', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    const clientId = await api.fixtureCustomer();

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

    // Create the credit note (draft) — 100.00 + 15% VAT. Deliberately NOT
    // linked to the invoice at create time: approveCreditNote auto-applies a
    // linked credit (creditNoteService ~167), and a later explicit `apply`
    // would then bump amount_paid a SECOND time. Create unlinked, apply once.
    const cn = await api.post<any>('/api/accounting/credit-notes', {
      type: 'customer',
      clientId,
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

    // Double-entry assertion (blind-review MEDIUM): approval must post a
    // BALANCED credit journal, not merely flip the CN status.
    const approvedCn = await api.get<any>(`/api/accounting/credit-notes?id=${creditNoteId}`);
    const cnJournalId = approvedCn.glJournalEntryId ?? approvedCn.gl_journal_entry_id;
    expect(cnJournalId, 'CN approval must post a GL journal').toBeTruthy();
    const cnJournal = await api.get<any>(
      `/api/accounting/journal-entries-detail?id=${cnJournalId}`,
    );
    expect(cnJournal.status).toBe('posted');
    const cnDr = cnJournal.lines.reduce((t: number, l: any) => t + Number(l.debit), 0);
    const cnCr = cnJournal.lines.reduce((t: number, l: any) => t + Number(l.credit), 0);
    expect(cnDr).toBeCloseTo(115, 2);
    expect(cnCr).toBeCloseTo(115, 2);

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
