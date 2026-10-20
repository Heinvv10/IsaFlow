// R-127 re-check MEDIUM (Hein): a bank-first settlement needs a sanctioned undo.
//
// The exit is two steps. Unapply (now a UI action on the payment page, through
// supplier-payments-action) moves only the subledger: the bill reopens and the
// payment becomes an unapplied credit still holding the provisional's claim.
// Voiding that FULLY UNAPPLIED payment then undoes the settlement outright, in
// one savepoint: it cancels the payment (releasing the claim), reverses the
// reclass AND the provisional, and returns the bank line to 'imported' with
// provisional_je_id cleared. The bill stays open on AP, booked once by its own
// journal; the bank line is free to allocate — and allocating it to the bill
// books the payment once. Nothing is ever double-booked. Refused while the
// payment still pays a bill, or while its bank line is reconciled.
import { describe, expect, it } from 'vitest';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { unapplySupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import { applyBankLineToSupplierInvoices } from '@/modules/accounting/services/ap/supplierBankPaymentService';
import {
  bankGl, btState, callRoute, company, companySnapshot, expenseGl, inTx, invoiceState, jeState,
  payableGl, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional, useR127Fixture, user, vatGl,
} from './r127-double-booking.helpers';

useR127Fixture();

async function settled(total: number) {
  const doc = await seedDoc();
  const { je, bt } = await seedProvisional({ totalAmount: total, evidencedBy: doc });
  const invoiceId = await seedInvoice({ documentId: doc, totalAmount: total });
  await inTx(() => approveSupplierInvoice(company, invoiceId, user));
  const [p] = await paymentsFor(bt, invoiceId);
  const invoiceJe = (await invoiceState(invoiceId)).gl_journal_entry_id!;
  return { je, bt, invoiceId, invoiceJe, paymentId: p!.id, reclassJe: p!.gl_journal_entry_id! };
}

const action = (a: string, paymentId: string) =>
  callRoute(supplierPaymentsAction, '/api/accounting/supplier-payments-action', { action: a, paymentId });

/** Net per account over these journals AND their reversal contras (all posted, reversed or not). */
async function netOver(ids: string[]) {
  const { rows } = await pool.query(
    `SELECT l.gl_account_id, SUM(l.debit - l.credit)::float AS net
     FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     WHERE e.company_id = $2 AND e.status = 'posted' AND (e.id = ANY($1::uuid[]) OR e.reversal_of_id = ANY($1::uuid[]))
     GROUP BY l.gl_account_id`, [ids, company]);
  const n = (a: string) => Math.round(Number(rows.find((r) => r.gl_account_id === a)?.net ?? 0) * 100) / 100;
  return { expense: n(expenseGl), vat: n(vatGl), ap: n(payableGl), bank: n(bankGl) };
}

async function paymentStatus(id: string): Promise<string> {
  return String((await pool.query('SELECT status FROM supplier_payments WHERE id=$1', [id])).rows[0].status);
}

describe('R-127: the Unapply action on the payment page', () => {
  it('supplier-payments-action unapply reopens the bill and leaves the payment an unapplied credit', async () => {
    const s = await settled(901.60);
    const res = await action('unapply', s.paymentId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const inv = await invoiceState(s.invoiceId);
    expect(inv.status).toBe('approved');
    expect(inv.paid).toBe(0);
    expect(await paymentStatus(s.paymentId)).toBe('processed');
  });
});

describe('R-127: voiding a fully unapplied settlement undoes it', () => {
  it('through the route: both journals reversed, the bank line free, the bill open once', async () => {
    const s = await settled(115.00);
    await inTx(() => unapplySupplierPayment(company, { paymentId: s.paymentId }, user));

    const res = await action('void', s.paymentId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);

    expect(await paymentStatus(s.paymentId)).toBe('cancelled');
    expect((await jeState(s.je)).reversed_at).not.toBeNull();
    expect((await jeState(s.reclassJe)).reversed_at).not.toBeNull();
    const line = (await pool.query('SELECT status, provisional_je_id FROM bank_transactions WHERE id=$1', [s.bt])).rows[0];
    expect(line).toEqual({ status: 'imported', provisional_je_id: null });
    const inv = await invoiceState(s.invoiceId);
    expect(inv.status).toBe('approved');
    expect(inv.paid).toBe(0);
    // The bill's own journal alone: R100 expense, R15 VAT, R115 owed; no cash has left.
    expect(await netOver([s.je, s.reclassJe, s.invoiceJe])).toEqual({ expense: 100, vat: 15, ap: -115, bank: 0 });
  });

  it('voiding it again is refused with the ordinary status message, not a concurrency error', async () => {
    const s = await settled(906.10);
    await inTx(() => unapplySupplierPayment(company, { paymentId: s.paymentId }, user));
    expect((await action('void', s.paymentId)).statusCode).toBe(200);
    const before = await companySnapshot(s.invoiceId);
    const again = await action('void', s.paymentId);
    expect(again.statusCode).toBe(400);
    expect(JSON.stringify(again.body)).toMatch(/status: cancelled/);
    expect(JSON.stringify(again.body)).not.toMatch(/concurrently/);
    expect(await companySnapshot(s.invoiceId)).toEqual(before);
  });

  it('through MCP void_payment: the same undo', async () => {
    const s = await settled(902.70);
    await inTx(() => unapplySupplierPayment(company, { paymentId: s.paymentId }, user));
    const ctx = { companyId: company, userId: user, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const out = await inTx(() => voidPaymentTool.handler(
      { payment_id: s.paymentId, idempotency_key: crypto.randomUUID() }, ctx as never));
    expect(out.isError ?? false).toBe(false);
    expect(await paymentStatus(s.paymentId)).toBe('cancelled');
    expect((await jeState(s.je)).reversed_at).not.toBeNull();
    expect((await btState(s.bt)).status).toBe('imported');
  });

  it('after the undo the bank line pays the bill once: nothing is double-booked', async () => {
    const s = await settled(903.80);
    await inTx(() => unapplySupplierPayment(company, { paymentId: s.paymentId }, user));
    expect((await action('void', s.paymentId)).statusCode).toBe(200);

    const paid = await inTx(() => applyBankLineToSupplierInvoices(company, {
      bankTxId: s.bt, userId: user, allocations: [{ invoiceId: s.invoiceId, amount: 903.80 }],
    }));
    expect((await invoiceState(s.invoiceId)).status).toBe('paid');
    expect(await netOver([s.je, s.reclassJe, s.invoiceJe, paid.journalEntryId]))
      .toEqual({ expense: 785.91, vat: 117.89, ap: 0, bank: -903.80 });
  });

  it('is refused while the payment still pays a bill, pointing to the Unapply action', async () => {
    const s = await settled(904.90);
    const before = await companySnapshot(s.invoiceId);
    const res = await action('void', s.paymentId);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Unapply on the payment/);
    expect(await companySnapshot(s.invoiceId)).toEqual(before);
  });

  it('is refused while the bank line is reconciled, writing nothing', async () => {
    const s = await settled(905.95);
    await inTx(() => unapplySupplierPayment(company, { paymentId: s.paymentId }, user));
    await pool.query("UPDATE bank_transactions SET status='reconciled' WHERE id=$1", [s.bt]);
    const before = await companySnapshot(s.invoiceId);
    const res = await action('void', s.paymentId);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/reconcil/i);
    expect(await companySnapshot(s.invoiceId)).toEqual(before);
    expect(await paymentStatus(s.paymentId)).toBe('processed');
  });
});
