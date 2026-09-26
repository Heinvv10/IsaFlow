// R-127 — undoing a bank-first settlement (Hein's decision, option C).
//
// A settlement payment's journal is a RECLASS of the provisional (DR AP, CR the
// expense/VAT the provisional debited), not a bank payment. Voiding it would
// reverse only that reclass: the bill reopens and the provisional stands, so the
// expense and VAT are back in the ledger twice. Void is therefore REFUSED, on
// every void path, before anything is written, and names the remedy: unapply.
// Unapply moves only the subledger — the bill reopens and the payment stays a
// live unapplied credit on the same supplier, still holding the provisional's
// claim — so the GL keeps the bill once and the credit can go to the right bill.
import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import { approveSupplierInvoice, postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { unapplySupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import {
  applySupplierPaymentPlan, planSupplierPaymentApplication,
} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import { request, response } from './mfa-impersonation-postgres.helpers';
import {
  company, inTx, invoiceState, otherCompany, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional,
  slipLedger, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();

let token = '';
beforeAll(async () => {
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

/** A slip whose invoice was approved and settled by its provisional. */
async function settled(total: number) {
  const doc = await seedDoc();
  const { je, bt } = await seedProvisional({ totalAmount: total, evidencedBy: doc });
  const invoiceId = await seedInvoice({ documentId: doc, totalAmount: total });
  await inTx(() => approveSupplierInvoice(company, invoiceId, user));
  const [payment] = await paymentsFor(bt, invoiceId);
  expect(payment).toBeDefined();
  return { doc, je, bt, invoiceId, paymentId: payment!.id };
}

async function paymentRow(id: string) {
  const { rows } = await pool.query(
    `SELECT sp.status, sp.total_amount::float AS total,
            COALESCE((SELECT SUM(amount_allocated) FROM payment_allocations WHERE payment_id = sp.id), 0)::float AS allocated
     FROM supplier_payments sp WHERE sp.id = $1`, [id]);
  return rows[0] as { status: string; total: number; allocated: number };
}

const journalCount = async (c: string) => Number((await pool.query(
  'SELECT COUNT(*) FROM gl_journal_entries WHERE company_id=$1', [c])).rows[0].count);

/** Everything a void could have written, captured before and compared after. */
async function snapshot(s: { je: string; bt: string; invoiceId: string; paymentId: string }) {
  return {
    ledger: await slipLedger(s.je, s.bt, s.invoiceId),
    invoice: await invoiceState(s.invoiceId),
    payment: await paymentRow(s.paymentId),
    journals: await journalCount(company),
  };
}

describe('R-127: a settlement payment cannot be voided — every void path refuses, writing nothing', () => {
  it('the supplier-payments-action route answers 400 naming unapply', async () => {
    const s = await settled(501.40);
    const before = await snapshot(s);

    const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
    req.url = '/api/accounting/supplier-payments-action';
    req.body = { action: 'void', paymentId: s.paymentId };
    const out = response();
    await supplierPaymentsAction(req as never, out.res as never);

    expect(out.state.statusCode).toBe(400);
    expect(JSON.stringify(out.state.body)).toMatch(/unapply/i);
    expect(await snapshot(s)).toEqual(before);
  });

  it('the MCP void_payment tool is refused with a coded refusal naming unapply', async () => {
    const s = await settled(502.55);
    const before = await snapshot(s);

    const ctx = { companyId: company, userId: user, scopes: ['write:invoices', 'write:post'], tokenJti: null, oauthAppId: null };
    const err = await inTx(() => voidPaymentTool.handler(
      { payment_id: s.paymentId, idempotency_key: crypto.randomUUID() }, ctx as never,
    )).then(() => null, (e: unknown) => e);

    expect(err).not.toBeNull();
    expect(isRefusalCoded(err)).toBe(true);
    expect((err as Error).message).toMatch(/unapply/i);
    expect(await snapshot(s)).toEqual(before);
  });

  it('another company cannot void it either — not found, and nothing about the settlement leaks', async () => {
    const s = await settled(503.70);
    const before = await snapshot(s);
    const c = await pool.connect();
    let err: unknown = null;
    try {
      await c.query('BEGIN');
      const { als } = await import('@/lib/als');
      await als.run({ client: c, userId: user, companyId: otherCompany, claims: {} } as never,
        () => voidSupplierPayment(otherCompany, s.paymentId, user)).catch((e: unknown) => { err = e; });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((err as Error).message).toMatch(/not found/i);
    expect((err as Error).message).not.toMatch(/provisional|unapply/i);
    expect(await snapshot(s)).toEqual(before);
  });
});

describe('R-127: unapply is the undo — subledger only, the claim held', () => {
  it('unapply reopens the bill for R115 and leaves a R115 unapplied credit; the GL does not move', async () => {
    const s = await settled(115.00);
    await inTx(() => unapplySupplierPayment(company, { paymentId: s.paymentId }, user));

    const inv = await invoiceState(s.invoiceId);
    expect(inv.status).toBe('approved');
    expect(inv.paid).toBe(0);
    expect(await paymentRow(s.paymentId)).toEqual({ status: 'processed', total: 115.00, allocated: 0 });
    // Expense and VAT once, bank once, net AP nil: the R115 the bill owes is
    // exactly offset by the R115 unapplied payment on the same supplier.
    expect(await slipLedger(s.je, s.bt, s.invoiceId)).toEqual({ expense: 100.00, vat: 15.00, ap: 0, bank: -115.00 });
  });

  it('the unapplied credit can be applied to another bill of the same supplier', async () => {
    const s = await settled(504.85);
    await inTx(() => unapplySupplierPayment(company, { paymentId: s.paymentId }, user));
    const other = await seedInvoice({ documentId: await seedDoc(), totalAmount: 504.85 });
    await inTx(() => approveSupplierInvoice(company, other, user));
    expect((await invoiceState(other)).status).toBe('approved');

    await inTx(async () => {
      const plan = await planSupplierPaymentApplication(company, s.paymentId, [{ invoiceId: other, amount: 504.85 }]);
      await applySupplierPaymentPlan(company, plan, user);
    });
    expect((await invoiceState(other)).status).toBe('paid');
    expect((await invoiceState(s.invoiceId)).status).toBe('approved');
    expect(await paymentRow(s.paymentId)).toEqual({ status: 'reconciled', total: 504.85, allocated: 504.85 });
  });

  it('the reopened bill cannot be settled by the provisional a second time', async () => {
    const s = await settled(505.90);
    await inTx(() => unapplySupplierPayment(company, { paymentId: s.paymentId }, user));

    // Re-approving the original is refused (it is approved), and Post to GL is a no-op.
    await expect(inTx(() => approveSupplierInvoice(company, s.invoiceId, user))).rejects.toThrow(/Cannot approve/);
    expect((await inTx(() => postSupplierInvoiceToGL(company, s.invoiceId, user))).alreadyPosted).toBe(true);
    // A fresh bill raised from the same slip approves without touching the provisional.
    const again = await seedInvoice({ documentId: s.doc, totalAmount: 505.90 });
    await inTx(() => approveSupplierInvoice(company, again, user));
    expect((await invoiceState(again)).status).toBe('approved');

    const live = Number((await pool.query(
      "SELECT COUNT(*) FROM supplier_payments WHERE company_id=$1 AND settles_provisional_je_id=$2 AND status <> 'cancelled'",
      [company, s.je])).rows[0].count);
    expect(live).toBe(1);
  });
});
