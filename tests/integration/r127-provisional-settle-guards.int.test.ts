// R-127 — which provisional journals an approved supplier invoice may turn into
// its payment, and which it must leave alone.
//
// Only a provisional that is posted, unreversed, evidenced (needs_evidence =
// false) by the invoice's OWN source document, in the SAME company, and not
// already consumed by another invoice qualifies. Everything else must leave the
// approval exactly as it was before R-127: the invoice's journal posts, no
// payment is created, and the invoice stays approved and unpaid.
import { describe, expect, it } from 'vitest';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import {
  company, inTx, invoiceState, jeState, otherAccounts, otherCompany, paymentsFor, pool,
  seedDoc, seedInvoice, seedProvisional, slipLedger, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();

const approve = (invoiceId: string) => inTx(() => approveSupplierInvoice(company, invoiceId, user));

/** The pre-R-127 outcome for a draft invoice of `total`: its journal posted, nothing settled. */
async function expectApprovedUnsettled(invoiceId: string, bt: string, total: number): Promise<void> {
  const inv = await invoiceState(invoiceId);
  expect(inv.status).toBe('approved');
  expect(inv.paid).toBe(0);
  expect(inv.gl_journal_entry_id).not.toBeNull();
  expect(await paymentsFor(bt, invoiceId)).toHaveLength(0);
  const apOnInvoiceJournal = (await pool.query(
    `SELECT COALESCE(SUM(credit - debit),0)::float AS cr FROM gl_journal_lines l
     JOIN gl_accounts a ON a.id = l.gl_account_id
     WHERE l.journal_entry_id=$1 AND l.company_id=$2 AND a.account_subtype='payable'`,
    [inv.gl_journal_entry_id, company],
  )).rows[0].cr as number;
  expect(apOnInvoiceJournal).toBe(total);
}

describe('R-127 guards: a provisional that does not qualify is not used', () => {
  it('an invoice with no provisional behind its slip approves exactly as before', async () => {
    const doc = await seedDoc();
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 201.25 });
    const approved = await approve(invoiceId);
    expect(approved.status).toBe('approved');
    await expectApprovedUnsettled(invoiceId, crypto.randomUUID(), 201.25);
  });

  it('a provisional still needing evidence is not used, even carrying the slip id', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 202.40, evidencedBy: doc, needsEvidence: true });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 202.40 });
    await approve(invoiceId);
    await expectApprovedUnsettled(invoiceId, bt, 202.40);
    expect((await jeState(je)).needs_evidence).toBe(true);
  });

  it('a reversed provisional is not used', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 203.55, evidencedBy: doc });
    await inTx(() => reverseJournalEntry(company, je, user));
    expect((await jeState(je)).reversed_at).not.toBeNull();
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 203.55 });
    await approve(invoiceId);
    await expectApprovedUnsettled(invoiceId, bt, 203.55);
  });

  it('a provisional that never posted (draft) is not used', async () => {
    const doc = await seedDoc();
    const { bt } = await seedProvisional({ totalAmount: 204.70, evidencedBy: doc, draft: true });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 204.70 });
    await approve(invoiceId);
    await expectApprovedUnsettled(invoiceId, bt, 204.70);
  });

  it('one provisional, two invoices from the same slip: only the first is settled by it', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 205.85, evidencedBy: doc });
    const first = await seedInvoice({ documentId: doc, totalAmount: 205.85 });
    const second = await seedInvoice({ documentId: doc, totalAmount: 205.85 });

    await approve(first);
    expect((await invoiceState(first)).status).toBe('paid');

    await approve(second);
    // The second invoice posts its own journal and is left for a human: the cash
    // behind the provisional has already been spent on the first.
    const inv2 = await invoiceState(second);
    expect(inv2.status).toBe('approved');
    expect(inv2.paid).toBe(0);
    const live = (await pool.query(
      "SELECT COUNT(*)::int AS n FROM supplier_payments WHERE company_id=$1 AND reference=$2 AND status <> 'cancelled'",
      [company, bt],
    )).rows[0].n as number;
    expect(live).toBe(1);
    expect((await slipLedger(je, bt, first)).ap).toBe(0);
  });

  it('another company\'s provisional carrying the same slip id is ignored', async () => {
    const doc = await seedDoc();
    // A journal in ANOTHER tenant stamped with this tenant's document id — the
    // FK on source_document_id does not check company, so only the query can.
    const { je: foreignJe, bt: foreignBt } = await seedProvisional({
      totalAmount: 206.95, evidencedBy: doc, companyId: otherCompany, accounts: otherAccounts,
    });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 206.95 });
    await approve(invoiceId);
    await expectApprovedUnsettled(invoiceId, foreignBt, 206.95);
    const foreignPayments = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM supplier_payments WHERE company_id=$1', [otherCompany],
    )).rows[0].n as number;
    expect(foreignPayments).toBe(0);
    const foreign = await jeState(foreignJe);
    expect(foreign.reversed_at).toBeNull();
    expect(foreign.status).toBe('posted');
  });
});

describe('R-127 amounts: the invoice and the bank line differ', () => {
  it('invoice R130 > bank R115: settles R115, leaves R15 open on AP, books the invoice\'s own figures', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 115.00, evidencedBy: doc });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 130.00 });
    await approve(invoiceId);

    const inv = await invoiceState(invoiceId);
    expect(inv.status).toBe('partially_paid');
    expect(inv.paid).toBe(115.00);
    const payments = await paymentsFor(bt, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.total).toBe(115.00);
    expect(payments[0]!.allocated).toBe(115.00);

    // Expense and VAT are the INVOICE's (R113.04 + R16.96), once; the bank R115
    // once; AP holds exactly the R15 the bill still owes — and the subledger says
    // the same (130 − 115).
    expect(await slipLedger(je, bt, invoiceId)).toEqual({ expense: 113.04, vat: 16.96, ap: -15.00, bank: -115.00 });
  });

  it('invoice R120 < bank R140: settles the invoice in full and leaves R20 unapplied on the payment', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 140.00, evidencedBy: doc });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 120.00 });
    await approve(invoiceId);

    const inv = await invoiceState(invoiceId);
    expect(inv.status).toBe('paid');
    expect(inv.paid).toBe(120.00);
    const payments = await paymentsFor(bt, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.total).toBe(140.00);
    expect(payments[0]!.allocated).toBe(120.00);
    // Partly applied: keeps 'processed' with R20 unapplied, which is where
    // list_unapplied_payments and reconcile_subledger surface it for a human.
    expect(payments[0]!.status).toBe('processed');

    // AP carries a R20 DEBIT — the overpayment — and that is exactly the payment's
    // unapplied remainder, so GL and subledger agree.
    expect(await slipLedger(je, bt, invoiceId)).toEqual({ expense: 104.35, vat: 15.65, ap: 20.00, bank: -140.00 });
  });
});
