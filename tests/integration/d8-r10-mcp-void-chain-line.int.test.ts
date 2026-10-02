/**
 * D8 round 10 (adversarial pass 3, brk-d8c F2): MCP void_payment / void_receipt looked for the payment's bank line
 * on the ROOT journal only. After O <- R <- R2 a statement line can be matched to R2 (it is unreversed), the void
 * reversed R2, and the line stayed 'matched' to a chain out of the ledger — claiming cash the GL no longer holds.
 * The void now finds lines on every journal of the chain, locks them before the payment, refuses reconciled cash
 * and frees them, as the HTTP void and receipt cancel do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  buildChain, confirmedReceipt, diff, postedBill, postedInvoice, processedPayment, settle, setup, tb, teardown, type Ctx,
} from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

/** A statement line matched (or reconciled) to journal `je`'s bank leg. */
async function lineOn(je: string, amount: number, status: 'matched' | 'reconciled'): Promise<string> {
  const leg = await one(sql`SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${c.fx.bankAccountId}::UUID`);
  const bt = await one(sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-05-20', ${amount}, ${`D8R10-H ${++c.seq}`}, ${status},
            ${String(leg.id)}::UUID) RETURNING id`);
  return String(bt.id);
}
const line = (bt: string) => one(sql`SELECT status, matched_journal_line_id IS NOT NULL AS has_match FROM bank_transactions WHERE id = ${bt}::UUID`);

describe.skipIf(!process.env.DATABASE_URL)('D8 round 10: MCP void frees a statement line matched to the chain head', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 10 MCP void chain line');
    c = await setup('D8R10M');
  }, 120000);
  afterAll(async () => {
    if (c) await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await teardown(c);
  }, 120000);

  for (const k of [2, 4]) {
    it(`void_payment k=${k}: line matched to the head — payment cancelled, out once, line imported`, async () => {
      const bill = await postedBill(c);
      const pay = await processedPayment(c, bill.id, 400);
      const head = (await buildChain(c, pay.je, k))[k]!;
      const bt = await lineOn(head, -400, 'matched');
      const t0 = await tb(c);
      const r = await inTx(c.fx, () => voidPaymentDocument(c.fx.companyId, 'supplier', pay.id, c.fx.userId));
      expect('refusal' in r, JSON.stringify(r)).toBe(false);
      expect((await one(sql`SELECT status FROM supplier_payments WHERE id = ${pay.id}::UUID`)).status).toBe('cancelled');
      expect(await line(bt)).toEqual({ status: 'imported', has_match: false });
      expect(diff(t0, await tb(c))).toMatchObject({ ap: -400, bank: 400 });
    });

    it(`void_receipt k=${k}: line matched to the head — receipt cancelled, out once, line imported`, async () => {
      const inv = await postedInvoice(c);
      const rc = await confirmedReceipt(c, inv.id, 500);
      const head = (await buildChain(c, rc.je, k))[k]!;
      const bt = await lineOn(head, 500, 'matched');
      const t0 = await tb(c);
      const r = await inTx(c.fx, () => voidPaymentDocument(c.fx.companyId, 'customer', rc.id, c.fx.userId));
      expect('refusal' in r, JSON.stringify(r)).toBe(false);
      expect((await one(sql`SELECT status FROM customer_payments WHERE id = ${rc.id}::UUID`)).status).toBe('cancelled');
      expect(await line(bt)).toEqual({ status: 'imported', has_match: false });
      expect(diff(t0, await tb(c))).toMatchObject({ ar: 500, bank: -500 });
    });
  }

  it('void_payment k=2: the head-matched line RECONCILED — refused, nothing changed', async () => {
    const bill = await postedBill(c);
    const pay = await processedPayment(c, bill.id, 300);
    const head = (await buildChain(c, pay.je, 2))[2]!;
    const bt = await lineOn(head, -300, 'reconciled');
    const t0 = await tb(c);
    const r = await settle(inTx(c.fx, () => voidPaymentDocument(c.fx.companyId, 'supplier', pay.id, c.fx.userId)));
    expect(JSON.stringify(r)).toMatch(/ReconciledCashError|reconciled/i);
    expect((await one(sql`SELECT status FROM supplier_payments WHERE id = ${pay.id}::UUID`)).status).toBe('processed');
    expect((await line(bt)).status).toBe('reconciled');
    expect(diff(t0, await tb(c))).toMatchObject({ ap: 0, bank: 0 });
  });
});
