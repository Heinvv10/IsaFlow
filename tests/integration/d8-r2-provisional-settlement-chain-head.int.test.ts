/**
 * D8 round 2: a bank-first provisional whose journal was reversed and the
 * reversal reversed by hand (X <- R <- R2) still books its slip — through R2 —
 * while X stays stamped `reversed_at`.
 *
 * Read by the stamp, approving the slip's bill found no provisional to settle
 * and booked the expense and VAT a second time. Now: the claim reads the chain
 * (journalStandsFragment), the settlement's undo reverses the provisional's
 * chain HEAD (journalChainHead), and the head cannot be reversed on its own
 * from the GL while the settlement holds it — the same refusal X itself gets.
 */
import { describe, expect, it } from 'vitest';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { unapplySupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import {
  bankGl, company, expenseGl, inTx, payableGl, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional,
  useR127Fixture, user, vatGl,
} from './r127-double-booking.helpers';

useR127Fixture();

/** Company-wide posted net per account — every posted entry, reversals included. */
async function ledger() {
  const { rows } = await pool.query(
    `SELECT l.gl_account_id, SUM(l.debit - l.credit)::float AS net
     FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     WHERE e.company_id = $1 AND e.status = 'posted' GROUP BY l.gl_account_id`, [company]);
  const n = (a: string) => Math.round(Number(rows.find((r) => r.gl_account_id === a)?.net ?? 0) * 100) / 100;
  return { expense: n(expenseGl), vat: n(vatGl), ap: n(payableGl), bank: n(bankGl) };
}

const contrasOf = async (id: string) => (await pool.query(
  "SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [id])).rows.length;

describe('D8 round 2: a re-reversed bank-first provisional settles its bill, and is undone at its head', () => {
  it('books the slip once, refuses reversing the head alone, and the void reverses the head', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    const r = await inTx(() => reverseJournalEntry(company, je, user));
    const head = (await inTx(() => reverseJournalEntry(company, r.id, user))).id;
    expect(await ledger()).toEqual({ expense: 100, vat: 15, ap: 0, bank: -115 });

    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115 });
    await inTx(() => approveSupplierInvoice(company, invoiceId, user));

    // Settled by the provisional: expense and VAT once, AP nil, bank once.
    expect(await ledger()).toEqual({ expense: 100, vat: 15, ap: 0, bank: -115 });
    const [payment] = await paymentsFor(bt, invoiceId);
    expect(payment).toBeDefined();

    // The head is half the settlement now, exactly as X would be.
    await expect(inTx(() => reverseJournalEntry(company, head, user))).rejects.toThrow(/half-booked|settled a supplier bill/);

    await inTx(() => unapplySupplierPayment(company, { paymentId: payment!.id }, user));
    await inTx(() => voidSupplierPayment(company, payment!.id, user));

    // The bill stands on AP by its own journal; the provisional's chain is out.
    expect(await ledger()).toEqual({ expense: 100, vat: 15, ap: -115, bank: 0 });
    expect(await contrasOf(head)).toBe(1);
  });
});
