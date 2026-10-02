/**
 * D8 round 6 (adversarial pass 2, brk-d8b, pre-existing): AR receipt cancel never touched bank lines. The
 * statement line of a bank-allocated receipt stayed 'allocated' — and a matched one 'matched' — to a journal
 * the cancel had just taken out of the ledger (or that was already out). Cancel now locks the line first and
 * frees it the way the AP void does; reconciled cash refuses the cancel.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { buildChain, confirmedReceipt, diff, postedInvoice, settle, setup, tb, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const lineOf = (bt: string) => one(sql`
  SELECT status, matched_journal_line_id IS NOT NULL AS has_match FROM bank_transactions WHERE id = ${bt}::UUID`);
const stateOf = (receipt: string, invoice: string) => one(sql`
  SELECT cp.status, ci.amount_paid::float8 AS paid FROM customer_payments cp, customer_invoices ci
  WHERE cp.id = ${receipt}::UUID AND ci.id = ${invoice}::UUID`);

/** A confirmed R400 receipt with a statement line on its bank leg, matched (or reconciled) as a statement match leaves it. */
async function receiptWithLine(status: 'matched' | 'reconciled') {
  const inv = await postedInvoice(c);
  const rc = await confirmedReceipt(c, inv.id, 400);
  const leg = await one(sql`SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${rc.je}::UUID AND gl_account_id = ${c.fx.bankAccountId}::UUID`);
  const bt = await one(sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-05-20', 400, ${`D8R6-RC ${++c.seq}`}, ${status}, ${String(leg.id)}::UUID)
    RETURNING id`);
  return { inv, rc, bt: String(bt.id) };
}

describe.skipIf(!process.env.DATABASE_URL)('D8 round 6: receipt cancel frees and guards its statement line', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 6 receipt bank line');
    c = await setup('D8R6R');
  }, 120000);
  afterAll(async () => {
    if (c) await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await teardown(c);
  }, 120000);

  for (const k of [0, 1, 2]) {
    it(`k=${k}: a bank-allocated receipt — cancelled, invoice reopened, line back to imported, out of the GL once`, async () => {
      const inv = await postedInvoice(c);
      const bt = await seedBankTx(c.fx, { date: '2026-05-22', amount: 1150, description: `D8R6-RA ${++c.seq}` });
      const a = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, null, c.fx.userId, undefined, 'customer',
        c.fx.customerId, undefined, undefined, undefined, undefined, inv.id));
      const p = String((await one(sql`SELECT id FROM customer_payments WHERE gl_journal_entry_id = ${a.journalEntryId}::UUID`)).id);
      await buildChain(c, a.journalEntryId, k);
      const t0 = await tb(c);
      const r = await settle(inTx(c.fx, () => cancelCustomerPayment(c.fx.companyId, p, c.fx.userId)));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await lineOf(bt)).toEqual({ status: 'imported', has_match: false });
      expect(await stateOf(p, inv.id)).toEqual({ status: 'cancelled', paid: 0 });
      expect(diff(t0, await tb(c))).toMatchObject(k % 2 === 0 ? { ar: 1150, bank: -1150 } : { ar: 0, bank: 0 });
    });
  }

  for (const k of [0, 1]) {
    it(`k=${k}: a receipt with a MATCHED statement line — cancelled and the line unmatched`, async () => {
      const { inv, rc, bt } = await receiptWithLine('matched');
      await buildChain(c, rc.je, k);
      const t0 = await tb(c);
      const r = await settle(inTx(c.fx, () => cancelCustomerPayment(c.fx.companyId, rc.id, c.fx.userId)));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await lineOf(bt)).toEqual({ status: 'imported', has_match: false });
      expect(await stateOf(rc.id, inv.id)).toEqual({ status: 'cancelled', paid: 0 });
      expect(diff(t0, await tb(c))).toMatchObject(k === 0 ? { ar: 400, bank: -400 } : { ar: 0, bank: 0 });
    });
  }

  it('a receipt whose statement line is RECONCILED — refused, nothing changed', async () => {
    const { inv, rc, bt } = await receiptWithLine('reconciled');
    const t0 = await tb(c);
    const r = await settle(inTx(c.fx, () => cancelCustomerPayment(c.fx.companyId, rc.id, c.fx.userId)));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/reconciled in the Sage import/);
    expect((await lineOf(bt)).status).toBe('reconciled');
    expect(await stateOf(rc.id, inv.id)).toEqual({ status: 'confirmed', paid: 400 });
    expect(diff(t0, await tb(c))).toMatchObject({ ar: 0, bank: 0 });
  });
});
