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
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { claimEvidencedProvisional } from '@/modules/accounting/services/ap/provisionalInvoiceSettlement';
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

/** A posted contra of `ofId` written by hand, as reverseJournalEntry leaves one — standing in for a row the product refuses. */
async function forgeContra(ofId: string): Promise<void> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, reversal_of_id, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 'forged reversal', 'posted', 'auto_bank_recon', $4, $5)`,
    [id, company, `D8F-${id.slice(0, 8)}`, ofId, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
     SELECT company_id, $1, gl_account_id, credit, debit, description FROM gl_journal_lines WHERE journal_entry_id = $2`,
    [id, ofId]);
  await pool.query('UPDATE gl_journal_entries SET reversed_at = NOW(), reversed_by = $2 WHERE id = $1', [ofId, user]);
}

describe('D8 round 4: the settlement refusal runs after the reversal claim and gives the claim back', () => {
  it('a refused reversal of a settled provisional\'s head leaves the head unclaimed, even when the request commits', async () => {
    const doc = await seedDoc();
    const { je } = await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    const r = await inTx(() => reverseJournalEntry(company, je, user));
    const head = (await inTx(() => reverseJournalEntry(company, r.id, user))).id;
    const bill = await seedInvoice({ documentId: doc, totalAmount: 115 });
    await inTx(() => approveSupplierInvoice(company, bill, user));

    // withAuth COMMITs a 4xx: run the refused reversal and commit anyway.
    const c = await pool.connect();
    let err: unknown = null;
    try {
      await c.query('BEGIN');
      await als.run({ client: c, userId: user, companyId: company, claims: {} } as never,
        () => reverseJournalEntry(company, head, user)).catch((e: unknown) => { err = e; });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(String((err as Error)?.message)).toMatch(/half-booked|settled a supplier bill/);
    const { rows } = await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE id = $1', [head]);
    expect(rows[0].reversed_at).toBeNull();
    expect(await contrasOf(head)).toBe(0);
  });

  it('voiding a settlement whose provisional chain is already OUT reverses the reclass only and frees the line', async () => {
    const doc = await seedDoc();
    const { je, bt } = await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    const r = await inTx(() => reverseJournalEntry(company, je, user));
    const head = (await inTx(() => reverseJournalEntry(company, r.id, user))).id;
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115 });
    await inTx(() => approveSupplierInvoice(company, invoiceId, user));
    const [payment] = await paymentsFor(bt, invoiceId);
    await inTx(() => unapplySupplierPayment(company, { paymentId: payment!.id }, user));
    await forgeContra(head); // the head reversed past the settlement guard: the chain is out
    const before = await ledger();

    await inTx(() => voidSupplierPayment(company, payment!.id, user));

    // Only the reclass came back out (DR expense/VAT, CR AP); nothing more off the provisional.
    expect(await ledger()).toEqual({
      expense: before.expense + 100, vat: before.vat + 15, ap: before.ap - 115, bank: before.bank,
    });
    const { rows } = await pool.query('SELECT status, provisional_je_id FROM bank_transactions WHERE id = $1', [bt]);
    expect(rows[0]).toEqual({ status: 'imported', provisional_je_id: null });
  });
});

describe('D8 round 6: a refused provisional claim leaves the request\'s lock_timeout as it found it', () => {
  it('a broken provisional chain refuses the claim and lock_timeout is back to the default for the rest of the request', async () => {
    const doc = await seedDoc();
    const { je } = await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    // Stamped reversed with no posted contra: the claim's SQL reads it as standing, the chain-head lock as broken.
    await pool.query('UPDATE gl_journal_entries SET reversed_at = NOW(), reversed_by = $2 WHERE id = $1', [je, user]);
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115 });

    const c = await pool.connect();
    let err: unknown = null;
    let after = '';
    try {
      await c.query('BEGIN');
      // The claim itself, as a caller without its own savepoint meets it — approve's
      // savepoint would roll the SET LOCAL back on its own and hide a missing restore.
      await als.run({ client: c, userId: user, companyId: company, claims: {} } as never, async () => {
        await claimEvidencedProvisional(company, invoiceId).catch((e: unknown) => { err = e; });
      });
      after = String((await c.query("SELECT current_setting('lock_timeout') AS v")).rows[0].v);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(String((err as Error)?.message)).toMatch(/reversal chain/);
    expect(after).toBe('0');
  });
});
