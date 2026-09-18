/**
 * Golden path (e): credit note → approve → apply to invoice.
 *
 * Was EXPECTED FAIL at baseline — July-4 audit H3: approveCreditNote did
 * String(cn.credit_date) on a pg Date → `time zone "gmt+0200" not
 * recognized` → credit notes could never leave draft. Flipped to a plain
 * test by P1.4's date fix (PR #193, creditNoteService serialization).
 *
 * TWO PATHS SINCE MIGRATION 677, because approving now APPLIES the note:
 *
 *   1. The manual path this spec has always covered, which now has to ask for
 *      it — `auto_apply: 'none'` — and then applies explicitly. Kept because it
 *      is still a real path (the REST route and the UI both expose it) and
 *      because its assertion is exact: THIS invoice, THIS amount.
 *   2. The new default, exercised through a note LINKED to its own fresh
 *      invoice and small enough to be absorbed by it. Deliberately not an
 *      unlinked note: these specs share the Demo company's books, the FIFO walk
 *      settles the OLDEST open documents, and an unlinked note would move
 *      balances this spec never created and cannot assert on.
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

    // Create the credit note (draft) — 100.00 + 15% VAT, unlinked.
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

    // Approve WITHOUT applying. The default would walk this customer's open
    // invoices oldest first and spend the credit before the explicit apply
    // below could — which is the behaviour path 2 covers. Here the note has to
    // survive approval unspent, so the instruction is stated.
    const approved = await api.post<any>('/api/accounting/credit-notes-action', {
      action: 'approve',
      creditNoteId,
      autoApply: 'none',
    });
    expect(approved.status).toBe('approved');
    expect(approved.applied_to_invoice_ids).toEqual([]);

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

    // Apply to the invoice, explicitly.
    const applied = await api.post<any>('/api/accounting/credit-notes-action', {
      action: 'apply',
      creditNoteId,
      invoiceId,
    });
    // The reply names the document the money went to, not just the amount.
    expect(applied.applied_to_invoice_ids).toEqual([
      { invoice_id: invoiceId, amount: 115 },
    ]);

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

/**
 * The DEFAULT since migration 677: approving applies the note, and the reply
 * names every document it settled.
 *
 * The note is linked to an invoice of its own and is smaller than that
 * invoice's balance, so the linked arm absorbs all of it and the FIFO walk has
 * nothing left to place. That keeps the assertion exact on a shared book.
 */
test('credit note: approve applies it and says which documents it settled', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    const clientId = await api.fixtureCustomer();

    const ref = gpRef('CNF');
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

    const cn = await api.post<any>('/api/accounting/credit-notes', {
      type: 'customer',
      clientId,
      customerInvoiceId: invoiceId,
      creditDate: today(),
      reason: gpRef('CNF'),
      subtotal: 100,
      taxRate: 15,
    });
    expect(cn.id).toBeTruthy();

    // No auto_apply argument: this is the default the change introduced.
    const approved = await api.post<any>('/api/accounting/credit-notes-action', {
      action: 'approve',
      creditNoteId: cn.id,
    });

    // 115 of credit against a 230 invoice: consumed in full, so the note is
    // 'applied' and nothing is left on account.
    expect(approved.status).toBe('applied');
    expect(approved.applied_to_invoice_ids).toEqual([
      { invoice_id: invoiceId, amount: 115 },
    ]);
    // The lines and the amount have to account for each other.
    const linesTotal = (approved.applied_to_invoice_ids as Array<{ amount: number }>)
      .reduce((t, l) => t + Number(l.amount), 0);
    expect(linesTotal).toBeCloseTo(Number(approved.appliedAmount), 2);

    // And the money really moved: 230 - 115.
    const after = await api.get<any>(
      `/api/accounting/customer-invoices-detail?id=${invoiceId}`,
    );
    expect(Number(after.total_amount) - Number(after.amount_paid)).toBeCloseTo(115, 2);
  } finally {
    await api.dispose();
  }
});
