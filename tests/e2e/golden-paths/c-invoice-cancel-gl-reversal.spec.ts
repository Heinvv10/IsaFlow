/**
 * Golden path (c): invoice → cancel → GL reversal exists.
 *
 * Was EXPECTED FAIL at baseline (July-4 audit C1: cancel was a status flip
 * only — Britech INV0000134 / R28,750; Demo JE-2026-00927 / R1,725).
 * Flipped to a plain test by P1.1 (PRs #197 + #198).
 *
 * Reversal semantics pinned here (PR #197's "double-removal" fix): the
 * original journal KEEPS status='posted' — reversal is metadata
 * (reversed_at on the original, reversal_of_id on the posted contra) — so
 * posted-only readers see original + contra netting to ZERO. Flipping the
 * original out of 'posted' would drop it from reports while the contra
 * stayed, driving the accounts to the NEGATIVE of the original.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('cancelling a posted invoice reverses its GL journal to a net-zero pair', async ({
  baseURL,
}) => {
  const api = await Api.login(baseURL!);
  try {
    const clientId = await api.fixtureCustomer();

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

    // Cancel the posted invoice; the response names the contra entry.
    const cancelResult = await api.post<any>('/api/accounting/customer-invoices-detail', {
      id: invoiceId,
      action: 'cancel',
    });
    expect(cancelResult.status).toBe('cancelled');
    const contraId = cancelResult.reversedJournalEntryId;
    expect(contraId, 'cancel must post a reversal journal').toBeTruthy();

    const cancelled = await api.get<any>(
      `/api/accounting/customer-invoices-detail?id=${invoiceId}`,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(
      cancelled.gl_journal_entry_id,
      'cancel must clear the journal link so a re-post cannot reuse the reversed pair',
    ).toBeFalsy();

    // Original: still POSTED (posted-only readers must keep counting it),
    // with reversal metadata set.
    const original = await api.get<any>(
      `/api/accounting/journal-entries-detail?id=${glEntryId}`,
    );
    expect(original.status, 'original must stay posted — reversal is metadata').toBe('posted');
    expect(original.reversedAt, 'original must carry reversed_at').toBeTruthy();

    // Contra: posted, linked back, and the PAIR nets to zero per account.
    const contra = await api.get<any>(
      `/api/accounting/journal-entries-detail?id=${contraId}`,
    );
    expect(contra.status).toBe('posted');
    expect(contra.reversalOfId).toBe(glEntryId);

    const perAccount = new Map<string, number>();
    for (const l of [...original.lines, ...contra.lines]) {
      perAccount.set(
        l.glAccountId,
        (perAccount.get(l.glAccountId) ?? 0) + Number(l.debit) - Number(l.credit),
      );
    }
    for (const [account, net] of perAccount) {
      expect(net, `account ${account} must net to zero across the reversal pair`).toBeCloseTo(
        0,
        2,
      );
    }
  } finally {
    await api.dispose();
  }
});
