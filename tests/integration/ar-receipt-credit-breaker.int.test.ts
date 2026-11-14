/**
 * Breaker repros of eba1b81995 (review round 1), kept: A — applying a receipt's remainder a refund already returned
 * was not refused; B — with the customer already below zero later on, `reverse_allocations`' dry run passed a
 * {refund, receipt} pair that lowers no date and the live call refused it (per-receipt judgment with a retry vs the
 * set judgment). Both red on eba1b81995. Plus the rule for a customer ALREADY below zero on some date
 * (ar/customerRunningCredit): a write that lowers that date is refused, one that does not is allowed — so such a
 * customer stays correctable by writes that leave the negative date alone. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { reverseAllocationsTool } from '@/lib/mcp/tools/writeBankReverseRange';
import { voidReceiptTool } from '@/lib/mcp/tools/writeVoidPayments';
import { planReceiptApplication, applyReceiptPlan } from '@/modules/accounting/services/ar/receiptApplicationService';
import { assertReceiptVoidKeepsCredit, withReceiptCancellationsJudged } from '@/modules/accounting/services/ar/customerVoidCredit';
import { sql } from '@/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, type K074Fixture } from './helpers/k074Fixture';
import { receiptLedger, verdict } from './ar-receipt-void-after-refund.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let fx: K074Fixture;
const L = receiptLedger(pool, () => fx);
beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => { try { await cleanupK074(pool, fx); } finally { await pool.end(); } });

const range = (from: string, to: string, dryRun: boolean, key = crypto.randomUUID()) => L.inTx(() => reverseAllocationsTool.handler(
  { bank_account_id: fx.bankAccount, from_date: from, to_date: to, idempotency_key: key, ...(dryRun ? { dry_run: true } : {}) }, L.ctx()));
const apply = (receipt: string, invoiceId: string, amount: number) => L.inTx(async () => {
  const plan = await planReceiptApplication(fx.company, receipt, [{ invoiceId, amount }]);
  return applyReceiptPlan(fx.company, plan, fx.user);
});
const voidReceipt = (receipt: string) => L.inTx(() => voidReceiptTool.handler(
  { receipt_id: receipt, idempotency_key: crypto.randomUUID() }, L.ctx()));
async function running(customer: string) {
  const { rows } = await pool.query(`
    WITH p AS (SELECT cp.payment_date d, cp.total_amount - LEAST(COALESCE((SELECT SUM(amount_allocated) FROM customer_payment_allocations a WHERE a.payment_id = cp.id),0), GREATEST(cp.total_amount,0)) amt
               FROM customer_payments cp WHERE cp.client_id = $1 AND cp.status <> 'cancelled')
    SELECT to_char(d,'MM-DD') d, SUM(SUM(amt)) OVER (ORDER BY d)::FLOAT cum FROM p GROUP BY d ORDER BY d`, [customer]);
  return Object.fromEntries(rows.map((r) => [r.d, r.cum]));
}
/** An allocation written straight to the tables (as pre-fix code could leave one): the customer below zero later. */
async function legacyApplication(receipt: string, invoiceId: string, amount: number) {
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)', [receipt, invoiceId, amount]);
  await pool.query('UPDATE customer_invoices SET amount_paid = amount_paid + $2 WHERE id = $1', [invoiceId, amount]);
}

describe('breaker', () => {
  it('A: applying the remainder a refund already returned is refused — running credit stays at or above zero', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 200, '2026-05-02');
    await L.allocated(c, -150, '2026-05-04'); // refund planned against R's unapplied 200
    const inv = await L.invoice(c, 200, '2026-05-01');
    const out = await verdict(apply(r.receipt, inv, 200));
    expect({ out, running: await running(c) }).toEqual({ out: 'RECEIPT_REFUSED', running: { '05-02': 200, '05-04': 50 } });
  }, 60_000);

  it('B: a {refund, receipt} pair that lowers no date passes dry AND live, on a customer below zero later on', async () => {
    const c = await L.newCustomer();
    const r0 = await L.allocated(c, 200, '2026-05-20');
    await L.allocated(c, -50, '2026-05-22', 'none', `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`);
    await L.allocated(c, 50, '2026-05-24', 'none', `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`);
    await L.allocated(c, -150, '2026-05-27');
    const inv = await L.invoice(c, 200, '2026-05-19');
    await legacyApplication(r0.receipt, inv, 200); // the breaker reached this through finding A, now refused
    const before = await running(c);
    const dry = await verdict(range('2026-05-22', '2026-05-24', true));
    const live = await verdict(range('2026-05-22', '2026-05-24', false));
    expect({ before, dry, live, after: await running(c) }).toEqual({
      before: { '05-20': 0, '05-22': -50, '05-24': 0, '05-27': -150 },
      dry: 'passed', live: 'passed',
      after: { '05-20': 0, '05-27': -150 }, // no date lower than before
    });
  }, 60_000);
});

describe('a customer already below zero on a later date', () => {
  it('a cancel that lowers a date left below zero is refused — dated before it, or on a later date still below zero', async () => {
    const c = await L.newCustomer();
    const early = await L.allocated(c, 100, '2026-05-05');
    const inv = await L.invoice(c, 300, '2026-05-01');
    const spent = await L.allocated(c, 300, '2026-05-06');
    await L.allocated(c, -300, '2026-05-10'); // credit as at 05-10: 100
    await legacyApplication(spent.receipt, inv, 300); // and now 05-10 reads -200
    const late = await L.allocated(c, 80, '2026-05-15');
    expect(await running(c)).toEqual({ '05-05': 100, '05-06': 100, '05-10': -200, '05-15': -120 });
    expect(await verdict(voidReceipt(early.receipt))).toBe('RECEIPT_REFUSED'); // would deepen 05-10 and 05-15
    expect(await verdict(voidReceipt(late.receipt))).toBe('RECEIPT_REFUSED'); // 05-15 would fall to -200
    expect(await running(c)).toEqual({ '05-05': 100, '05-06': 100, '05-10': -200, '05-15': -120 });
  }, 60_000);

  it('writes that lower no date stay allowed: a fully applied receipt cancels, a refund reverses', async () => {
    const c = await L.newCustomer();
    const inv = await L.invoice(c, 150, '2026-05-01');
    const full = await L.allocated(c, 150, '2026-05-05', 'fifo');
    const refund = await L.allocated(c, 120, '2026-05-06').then(() => L.allocated(c, -120, '2026-05-07'));
    await pool.query(`INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
      VALUES($1,$2,'2026-05-20',-90,'refund','confirmed',$3)`, [fx.company, c, fx.user]); // legacy: -90 from 05-20
    expect(await verdict(voidReceipt(full.receipt))).toBe('passed');
    expect(await verdict(voidReceipt(refund.receipt))).toBe('passed'); // raises 05-07 on: never refused
    expect(await L.credit(c)).toBe(30);
    expect(await applied(inv)).toBe(0);
  }, 60_000);

  it('a receipt dated after the negative date, whose own dates stay at zero or above, cancels', async () => {
    const c = await L.newCustomer();
    await pool.query(`INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
      VALUES($1,$2,'2026-05-08',-60,'refund','confirmed',$3)`, [fx.company, c, fx.user]); // -60 on 05-08 only
    await L.allocated(c, 100, '2026-05-12'); // 05-12: 40
    const late = await L.allocated(c, 40, '2026-05-14'); // 05-14: 80
    expect(await verdict(voidReceipt(late.receipt))).toBe('passed'); // leaves 05-14 at 40; 05-08 untouched
    expect(await running(c)).toEqual({ '05-08': -60, '05-12': 40 });
  }, 60_000);
});

describe('a judged bulk cancel whose receipt changes customer mid-call (security review, TOCTOU)', () => {
  it('is not passed on the old customer\'s credit: the per-receipt step refuses, retryable', async () => {
    const fine = await L.newCustomer();
    const r = await L.allocated(fine, 200, '2026-05-05'); // judged on `fine`: nothing else, credit 200 → 0 passes
    const spent = await L.newCustomer();
    await pool.query(`INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
      VALUES($1,$2,'2026-05-10',-150,'refund','confirmed',$3)`, [fx.company, spent, fx.user]); // `spent` below zero from 05-10
    const out = await verdict(L.inTx(() => withReceiptCancellationsJudged(fx.company, [r.receipt], async () => {
      // A reassignment (merge, gateway re-attribution) after the judgment, before the receipt's own step.
      await sql`UPDATE customer_payments SET client_id = ${spent}::UUID WHERE id = ${r.receipt}::UUID`;
      await assertReceiptVoidKeepsCredit(fx.company, [r.receipt]);
    })));
    expect(out).toBe('RECEIPT_REFUSED');
    // Judged afresh on its CURRENT customer, outside any judgment, the same cancel is refused on the figures.
    await pool.query('UPDATE customer_payments SET client_id = $1 WHERE id = $2', [spent, r.receipt]);
    const fresh = await L.inTx(() => assertReceiptVoidKeepsCredit(fx.company, [r.receipt])).catch((e: Error & { reason?: string }) => e);
    expect((fresh as { reason?: string }).reason).toBe('credit_ceiling');
  }, 60_000);
});

async function applied(invoiceId: string) {
  return Number((await pool.query('SELECT amount_paid FROM customer_invoices WHERE id = $1', [invoiceId])).rows[0].amount_paid);
}
