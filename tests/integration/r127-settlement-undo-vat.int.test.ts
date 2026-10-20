// R-127 L3 — undoing a settlement reverses TWO journals: the reclass and the
// provisional. When either sits in a VAT period filed since, its contra's date
// rolls forward past the lock, and MCP void_payment must say so for BOTH — it
// reported only the provisional's roll.
import { describe, expect, it } from 'vitest';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { unapplySupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import {
  company, inTx, paymentsFor, pool, seedDoc, seedInvoice, seedProvisional, today, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();

// Last month: settled while open, filed before the undo. A contra rolls forward
// only up to today, so the journals must sit in a period that ended before it.
const firstOfThisMonth = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
const monthEnd = new Date(firstOfThisMonth.getTime() - 86_400_000).toISOString().slice(0, 10);
const monthStart = `${monthEnd.slice(0, 8)}01`;

describe('R-127: the undo reports both contras\' VAT-lock rolls', () => {
  it('MCP void_payment names the reclass contra\'s roll as well as the provisional\'s', async () => {
    const doc = await seedDoc();
    const { bt } = await seedProvisional({ totalAmount: 115.00, evidencedBy: doc, date: monthEnd });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115.00, invoiceDate: monthEnd });
    await inTx(() => approveSupplierInvoice(company, invoiceId, user));
    const [p] = await paymentsFor(bt, invoiceId);
    await inTx(() => unapplySupplierPayment(company, { paymentId: p!.id }, user));
    // The period holding both journals is filed after the settlement.
    await pool.query(
      `INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type)
       VALUES($1,$2,$3,0,15,-15,NOW(),$4,'human')`,
      [company, monthStart, monthEnd, user]);

    const ctx = { companyId: company, userId: user, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null };
    const out = await inTx(() => voidPaymentTool.handler(
      { payment_id: p!.id, idempotency_key: crypto.randomUUID() }, ctx as never));
    expect(out.isError ?? false).toBe(false);
    const body = JSON.parse(out.content[0]!.text) as Record<string, unknown>;
    expect(body.reversal_date_roll).not.toBeNull();
    expect(body.reclass_reversal_date_roll).toBeTruthy();
  });
});
