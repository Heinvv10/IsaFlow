// R-127 — evidence attach vs. invoice approval on the same bank-first slip.
//
// A bank-first provisional journal (DR expense / DR VAT, CR bank) is evidenced
// by a captured slip (attachEvidenceToProvisional), and a supplier invoice
// raised from the SAME slip is later approved (approveSupplierInvoice), which
// posts DR expense / DR VAT, CR AP. Before the fix nothing connected the two:
// expense and input VAT posted twice, and the AP the invoice raised sat
// unsettled against a bank line that had already paid it (reproduced at
// c239c2b28: expense R200, VAT R30, AP credit R115, bank R115).
//
// Hein's decision: the provisional BECOMES the invoice's payment. The invoice
// posts its normal journal, and in the same transaction the provisional's
// expense/VAT is reclassed to AP and a supplier payment tied to the bank line
// is allocated to the invoice — so the ledger holds the bill once, AP nets to
// zero, the bank is credited once, and the subledger says paid.
//
// This drives the two REAL production functions end to end, on a fixture DB,
// and measures every account the whole transaction touched.
import { describe, expect, it } from 'vitest';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {
  bankGl, btState, company, expenseGl, inTx, invoiceState, jeState, payableGl, paymentsFor, pool,
  seedDoc, seedDraftInvoice, seedProvisional, supplier, today, useR127Fixture, user, vatGl,
} from './r127-double-booking.helpers';

useR127Fixture();

/** Net (debit − credit) per account across EVERY posted, unreversed journal in the company. */
async function companyNet(glAccountId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(l.debit - l.credit),0)::float AS net
     FROM gl_journal_lines l JOIN gl_journal_entries je ON je.id = l.journal_entry_id
     WHERE je.company_id = $2 AND l.gl_account_id = $1 AND je.status = 'posted' AND je.reversed_at IS NULL`,
    [glAccountId, company],
  );
  return Math.round(Number(rows[0].net) * 100) / 100;
}

describe('R-127: the evidenced provisional becomes the approved invoice\'s payment', () => {
  it('books the R115 bill once: expense R100, VAT R15, AP nil, bank R115 credited once; the invoice reads paid', async () => {
    const TOTAL = 115.00; // R100 net + R15 VAT, matches a R115 bank outflow exactly

    // (1) Bank-first: a provisional JE already posted DR expense 100 / DR VAT 15 / CR bank 115.
    const { je: provisionalJe, bt } = await seedProvisional({ totalAmount: TOTAL, supplierId: supplier });

    // (2) The same slip lands as a captured supplier invoice (draft, with a line item).
    const doc = await seedDoc();
    const invoiceId = await seedDraftInvoice({ documentId: doc, totalAmount: TOTAL });

    // (3) The REAL follow-up the capture routes run after creating the invoice.
    const attachResult = await inTx(() => attachEvidenceToProvisional(company, doc, supplier, TOTAL, today));
    expect(attachResult).toEqual({ attachedJeId: provisionalJe, bankTxId: bt });
    expect((await jeState(provisionalJe)).needs_evidence).toBe(false);

    // (4) The invoice is approved.
    const approved = await inTx(() => approveSupplierInvoice(company, invoiceId, user));

    // --- The ledger: one bill, one payment ---
    expect(await companyNet(expenseGl)).toBe(100.00);
    expect(await companyNet(vatGl)).toBe(15.00);
    expect(await companyNet(payableGl)).toBe(0);
    expect(await companyNet(bankGl)).toBe(-115.00);
    const bankCredits = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM gl_journal_lines l JOIN gl_journal_entries je ON je.id = l.journal_entry_id
       WHERE je.company_id=$1 AND l.gl_account_id=$2 AND l.credit > 0 AND je.status='posted' AND je.reversed_at IS NULL`,
      [company, bankGl],
    )).rows[0].n as number;
    expect(bankCredits).toBe(1);

    // The provisional itself is untouched: still posted, still evidenced, not reversed.
    const provisional = await jeState(provisionalJe);
    expect(provisional.status).toBe('posted');
    expect(provisional.reversed_at).toBeNull();
    expect(provisional.source_document_id).toBe(doc);
    expect((await btState(bt)).status).toBe('matched');

    // --- The subledger agrees: the invoice has its own journal and reads paid ---
    const invoiceRow = await invoiceState(invoiceId);
    expect(invoiceRow.gl_journal_entry_id).not.toBeNull();
    expect(invoiceRow.status).toBe('paid');
    expect(invoiceRow.paid).toBe(115.00);
    expect(approved.status).toBe('paid');

    // One supplier payment, tied to the bank line, fully allocated to the invoice,
    // carrying the journal that moved AP.
    const payments = await paymentsFor(bt, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.reference).toBe(bt);
    expect(payments[0]!.total).toBe(115.00);
    expect(payments[0]!.allocated).toBe(115.00);
    expect(payments[0]!.status).toBe('reconciled');
    expect(payments[0]!.gl_journal_entry_id).not.toBeNull();
    const paymentJournalAp = (await pool.query(
      `SELECT COALESCE(SUM(debit - credit),0)::float AS net FROM gl_journal_lines
       WHERE journal_entry_id=$1 AND company_id=$2 AND gl_account_id=$3`,
      [payments[0]!.gl_journal_entry_id, company, payableGl],
    )).rows[0].net as number;
    expect(paymentJournalAp).toBe(115.00);
  }, 30_000);
});
