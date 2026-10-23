/**
 * D8 round 12 (lead): a statement line can be matched to ANY journal of a payment journal's reversal chain — the root
 * O, a middle reversal, or the head. MCP void freed all of them (round 10); HTTP void, receipt cancel and batch
 * reversal looked at the root and the head only, so a line matched to a middle journal stayed 'matched' against a
 * chain the void took out of the ledger. Every flow now reads the chain's lines through one finder
 * (`bank/chainBankLines`), and all five reach the same end state for every k and every position.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { approveBatch, createBatch, processBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { reverseBatch } from '@/modules/accounting/services/ap/batchPaymentReversal';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  buildChain, confirmedReceipt, diff, postedBill, postedInvoice, processedPayment, setup, tb, teardown, type Ctx,
} from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const X = 400;

/** A statement line matched to journal `je`'s bank leg. */
async function lineOn(je: string, amount: number): Promise<string> {
  const leg = await one(sql`SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${c.fx.bankAccountId}::UUID`);
  const bt = await one(sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-05-20', ${amount}, ${`D8R12 ${++c.seq}`}, 'matched',
            ${String(leg.id)}::UUID) RETURNING id`);
  return String(bt.id);
}

/** A processed one-bill batch; its id, its journal and its member payment. */
async function processedBatch(billId: string): Promise<{ id: string; je: string; pay: string }> {
  const id = await inTx(c.fx, async () => {
    const b = await createBatch(c.fx.companyId, {
      batchDate: '2026-05-20', bankAccountId: c.fx.bankAccountId,
      payments: [{ supplierId: c.fx.supplierId, invoiceAllocations: [{ invoiceId: billId, amount: X }] }],
    }, c.fx.userId);
    await approveBatch(c.fx.companyId, b.id, c.fx.userId);
    await processBatch(c.fx.companyId, b.id, c.fx.userId);
    return b.id;
  });
  const r = await one(sql`SELECT b.gl_journal_entry_id AS je, p.id AS pay FROM supplier_payment_batches b
    JOIN supplier_payments p ON p.batch_id = b.id WHERE b.id = ${id}::UUID`);
  return { id, je: String(r.je), pay: String(r.pay) };
}

type Side = 'supplier' | 'customer';
interface Flow { name: string; side: Side; run: (doc: { id: string; pay: string }) => Promise<unknown> }
const flows: Flow[] = [
  { name: 'HTTP void', side: 'supplier', run: (d) => voidSupplierPayment(c.fx.companyId, d.pay, c.fx.userId) },
  { name: 'batch reversal', side: 'supplier', run: (d) => reverseBatch(c.fx.companyId, d.id, c.fx.userId) },
  { name: 'MCP void_payment', side: 'supplier', run: (d) => voidPaymentDocument(c.fx.companyId, 'supplier', d.pay, c.fx.userId) },
  { name: 'receipt cancel', side: 'customer', run: (d) => cancelCustomerPayment(c.fx.companyId, d.pay, c.fx.userId) },
  { name: 'MCP void_receipt', side: 'customer', run: (d) => voidPaymentDocument(c.fx.companyId, 'customer', d.pay, c.fx.userId) },
];

/** [k, position, index in the chain]: root always, the head from k=1, a middle reversal from k=2. */
const cases: [number, string, number][] = [];
for (let k = 0; k <= 4; k++) {
  cases.push([k, 'root', 0]);
  if (k >= 2) cases.push([k, 'middle', Math.floor(k / 2)]);
  if (k >= 1) cases.push([k, 'head', k]);
}

describe.skipIf(!process.env.DATABASE_URL)('D8 round 12: every flow frees a line matched to any journal of the chain', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 12 chain bank lines');
    c = await setup('D8R12');
  }, 120000);
  afterAll(async () => {
    if (c) {
      await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM supplier_payment_batches WHERE company_id = ${c.fx.companyId}::UUID`;
    }
    await teardown(c);
  }, 120000);

  for (const f of flows) {
    it.each(cases)(`${f.name}, k=%i, line on the %s: document voided, line imported, the chain out of the GL once`, async (k, _pos, at) => {
      let doc: { id: string; pay: string; je: string };
      if (f.side === 'customer') {
        const inv = await postedInvoice(c);
        const rc = await confirmedReceipt(c, inv.id, X);
        doc = { id: inv.id, pay: rc.id, je: rc.je };
      } else {
        const bill = await postedBill(c);
        if (f.name === 'batch reversal') {
          const b = await processedBatch(bill.id);
          doc = { id: b.id, pay: b.pay, je: b.je };
        } else {
          const p = await processedPayment(c, bill.id, X);
          doc = { id: bill.id, pay: p.id, je: p.je };
        }
      }
      const chain = await buildChain(c, doc.je, k);
      const bt = await lineOn(chain[at]!, f.side === 'customer' ? X : -X);
      const t0 = await tb(c);

      const r = await inTx(c.fx, () => f.run(doc));

      expect(r && typeof r === 'object' && 'refusal' in r, JSON.stringify(r)).toBe(false);
      const status = f.side === 'customer'
        ? (await one(sql`SELECT status FROM customer_payments WHERE id = ${doc.pay}::UUID`)).status
        : (await one(sql`SELECT status FROM supplier_payments WHERE id = ${doc.pay}::UUID`)).status;
      expect(status).toBe('cancelled');
      expect(await one(sql`SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = ${bt}::UUID`))
        .toEqual({ status: 'imported', matched_journal_line_id: null });
      // An even chain still carries the payment and goes out once; an odd one is already out and nothing posts.
      const [out, back] = k % 2 === 0 ? [X, -X] : [0, 0];
      expect(diff(t0, await tb(c))).toMatchObject(f.side === 'customer' ? { ar: out, bank: back } : { ap: back, bank: out });
    }, 30000);
  }
});
