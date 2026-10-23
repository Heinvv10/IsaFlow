/**
 * D8 round 16 (adversarial pass 4, brk-d8d F2): batch reversal's `lockBillCandidates` ran `SET LOCAL lock_timeout =
 * DEFAULT` inside the flow budget, so its journal lock, its contra INSERT and its posting UPDATE ran with lock_timeout
 * '0' — an unbounded wait. This samples `lock_timeout` before EVERY write or row lock of every D8 flow, from the moment
 * its budget is set: none may run with '0'.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { approveBatch, createBatch, processBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { reverseBatch } from '@/modules/accounting/services/ap/batchPaymentReversal';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { dismissProvisionalEntry } from '@/modules/accounting/services/bank/provisionalDismissService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { softDelete, undoDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn, seedBankTx } from './helpers/l1FifoFixture';
import { confirmedReceipt, postedBill, postedInvoice, processedPayment, provisional, setup, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const WRITE_OR_LOCK = /^\s*(INSERT|UPDATE|DELETE)\b|\bFOR (NO KEY )?(UPDATE|SHARE)\b/i;

/**
 * Run `flow` in a request transaction (rolled back) and return every write or row lock it issued, after its lock
 * budget was first set, while `lock_timeout` was '0'.
 */
async function unboundedStatements(flow: () => Promise<unknown>): Promise<string[]> {
  const cl: PoolClient = await c.fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<{ rows: Row[] }>;
  let budgetSet = false;
  const unbounded: string[] = [];
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
    if (!budgetSet && /set_config\('lock_timeout'/.test(t)) budgetSet = true;
    else if (budgetSet && WRITE_OR_LOCK.test(t)) {
      const v = String((await orig('SHOW lock_timeout')).rows[0]!.lock_timeout);
      if (v === '0') unbounded.push(t.replace(/\s+/g, ' ').trim().slice(0, 100));
    }
    return orig(...a);
  };
  await orig('BEGIN');
  try {
    await runOn(c.fx, cl, flow);
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    await orig('ROLLBACK');
    cl.release();
  }
  expect(budgetSet, 'the flow set no lock budget').toBe(true);
  return unbounded;
}

async function processedBatch(): Promise<string> {
  const bill = await postedBill(c);
  return inTx(c.fx, async () => {
    const b = await createBatch(c.fx.companyId, {
      batchDate: '2026-05-20', bankAccountId: c.fx.bankAccountId,
      payments: [{ supplierId: c.fx.supplierId, invoiceAllocations: [{ invoiceId: bill.id, amount: 300 }] }],
    }, c.fx.userId);
    await approveBatch(c.fx.companyId, b.id, c.fx.userId);
    await processBatch(c.fx.companyId, b.id, c.fx.userId);
    return b.id;
  });
}

const co = () => c.fx.companyId;
const u = () => c.fx.userId;
const flows: [string, () => Promise<() => Promise<unknown>>][] = [
  ['HTTP void', async () => { const p = await processedPayment(c, (await postedBill(c)).id, 400); return () => voidSupplierPayment(co(), p.id, u()); }],
  ['receipt cancel', async () => { const r = await confirmedReceipt(c, (await postedInvoice(c)).id, 500); return () => cancelCustomerPayment(co(), r.id, u()); }],
  ['MCP void_payment', async () => { const p = await processedPayment(c, (await postedBill(c)).id, 400); return () => voidPaymentDocument(co(), 'supplier', p.id, u()); }],
  ['MCP void_receipt', async () => { const r = await confirmedReceipt(c, (await postedInvoice(c)).id, 500); return () => voidPaymentDocument(co(), 'customer', r.id, u()); }],
  ['batch reversal', async () => { const b = await processedBatch(); return () => reverseBatch(co(), b, u()); }],
  ['bank reversal (account allocation)', async () => {
    const tx = await seedBankTx(c.fx, { date: '2026-05-12', amount: -230, description: `D8R16 A ${++c.seq}` });
    await inTx(c.fx, () => allocateTransaction(co(), tx, c.acct.expense!, u(), undefined, 'account'));
    return () => reverseReconciledTransaction(co(), tx, u());
  }],
  ['bank reversal (customer receipt allocation)', async () => {
    const inv = await postedInvoice(c);
    const tx = await seedBankTx(c.fx, { date: '2026-05-22', amount: 1150, description: `D8R16 C ${++c.seq}` });
    await inTx(c.fx, () => allocateTransaction(co(), tx, null, u(), undefined, 'customer', c.fx.customerId,
      undefined, undefined, undefined, undefined, inv.id));
    return () => reverseReconciledTransaction(co(), tx, u());
  }],
  ['AP bill cancel', async () => { const b = await postedBill(c); return () => cancelSupplierInvoice(co(), b.id, u()); }],
  ['AR invoice cancel', async () => { const i = await postedInvoice(c); return () => cancelCustomerInvoice(co(), i.id, u()); }],
  ['credit-note cancel', async () => {
    const inv = await postedInvoice(c);
    const id = await inTx(c.fx, async () => {
      const n = await createCreditNote(co(), { type: 'customer', clientId: c.fx.customerId, customerInvoiceId: inv.id,
        creditDate: '2026-05-10', subtotal: 100, taxRate: 15 }, u());
      await approveCreditNote(co(), n.id, u());
      return n.id;
    });
    return () => cancelCreditNote(co(), id, u());
  }],
  ['provisional dismiss', async () => { const pv = await provisional(c, 610 + (++c.seq)); return () => dismissProvisionalEntry(co(), pv.je, u()); }],
  ['automatic evidence attach', async () => {
    const amount = 820 + (++c.seq);
    const pv = await provisional(c, amount);
    await sql`UPDATE bank_transactions SET predicted_supplier_id = ${c.fx.supplierId}::UUID WHERE id = ${pv.bt}::UUID`;
    const doc = await one(sql`INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
      VALUES (${co()}::UUID, ${`d8r16-${c.seq}.pdf`}, 'application/pdf', 'reviewed', 'supplier_invoice') RETURNING id`);
    return () => attachEvidenceToProvisional(co(), String(doc.id), c.fx.supplierId, amount, '2026-05-15');
  }],
  ['soft delete (customer invoice)', async () => { const i = await postedInvoice(c); return () => softDelete(co(), 'customer_invoice', i.id, u()); }],
  ['soft delete (supplier bill)', async () => { const b = await postedBill(c); return () => softDelete(co(), 'supplier_invoice', b.id, u()); }],
  ['undo soft delete (customer invoice)', async () => {
    const i = await postedInvoice(c);
    await inTx(c.fx, () => softDelete(co(), 'customer_invoice', i.id, u()));
    return () => undoDelete(co(), 'customer_invoice', i.id, u());
  }],
];

describe.skipIf(!process.env.DATABASE_URL)('D8 round 16: no write or lock of a D8 flow runs with lock_timeout 0', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 16 lock_timeout trail');
    c = await setup('D8R16T');
  }, 120000);
  afterAll(async () => {
    if (c) {
      await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM credit_note_allocations WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM credit_notes WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM supplier_payment_batches WHERE company_id = ${c.fx.companyId}::UUID`;
    }
    await teardown(c);
  }, 120000);

  it.each(flows)('%s', async (_name, prepare) => {
    const flow = await prepare();
    expect(await unboundedStatements(flow)).toEqual([]);
  }, 30000);
});
