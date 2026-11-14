/**
 * Receipt void after refund (Hein, 2026-11-14): cancelling a customer receipt whose unapplied cash a customer refund
 * has already returned is REFUSED before any write (`ar/customerVoidCredit`) — it would take the customer's running
 * on-account credit below zero from the receipt's date on. A fully applied receipt lowers nothing and still cancels.
 * Every cancellation path asks it: MCP `void_receipt` and `reverse_bank_allocation` (through
 * `bank/bankAllocationUnwind.unwindOnePayment`) and the receipts screen (`cancelCustomerPayment`). The customer is taken
 * TRIED: a refund holding it makes the cancel retryable at once, never a wait. Red on master (every cancel passed).
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { voidReceiptTool } from '@/lib/mcp/tools/writeVoidPayments';
import { reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { planCustomerRefund } from '@/modules/accounting/services/ar/customerRefundDocument';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, type K074Fixture } from './helpers/k074Fixture';
import { receiptLedger, verdict } from './ar-receipt-void-after-refund.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let fx: K074Fixture;
const L = receiptLedger(pool, () => fx);
beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => { try { await cleanupK074(pool, fx); } finally { await pool.end(); } });

const voidReceipt = (receipt: string) => L.inTx(() => voidReceiptTool.handler(
  { receipt_id: receipt, idempotency_key: crypto.randomUUID() }, L.ctx()));
const reverseLine = (line: string) => L.inTx(() => reverseBankAllocationTool.handler(
  { transaction_id: line, idempotency_key: crypto.randomUUID() }, L.ctx()));

/** A confirmed receipt with no journal and no bank line (shape 3: captured by hand, never posted). */
async function handReceipt(customer: string, amount: number, date: string): Promise<string> {
  const { rows: [p] } = await pool.query(
    `INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
     VALUES($1,$2,$3::DATE,$4,'eft','confirmed',$5) RETURNING id`, [fx.company, customer, date, amount, fx.user]);
  return String(p.id);
}

describe('cancelling a receipt whose cash a refund has returned', () => {
  it('void_receipt and reverse_bank_allocation refuse it, by name and figures, and write nothing', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 500, '2026-05-05');
    await L.allocated(c, -500, '2026-05-10'); // the refund spends it
    const err = await voidReceipt(r.receipt).catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('RECEIPT_REFUSED');
    expect((err as Error).message).toMatch(/^Cancelling this receipt would leave RVC \w+ owing the company: it takes R\s?500\.00 .* from 2026-05-05, .* only R\s?0\.00 is on account/);
    expect(await verdict(reverseLine(r.line))).toBe('RECEIPT_REFUSED');
    expect({ receipt: await L.statusOf(r.receipt), line: await L.lineStatus(r.line), credit: await L.credit(c) })
      .toEqual({ receipt: 'confirmed', line: 'allocated', credit: 0 });
  }, 60_000);

  it('the receipts screen (cancelCustomerPayment) refuses it too — bank-allocated and hand-captured alike', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 400, '2026-05-05');
    const hand = await handReceipt(c, 300, '2026-05-06');
    await L.allocated(c, -700, '2026-05-10');
    expect(await verdict(L.inTx(() => cancelCustomerPayment(fx.company, r.receipt, fx.user)))).toBe('RECEIPT_REFUSED');
    expect(await verdict(L.inTx(() => cancelCustomerPayment(fx.company, hand, fx.user)))).toBe('RECEIPT_REFUSED');
    expect(await verdict(voidReceipt(hand))).toBe('RECEIPT_REFUSED');
    expect({ r: await L.statusOf(r.receipt), hand: await L.statusOf(hand), credit: await L.credit(c) })
      .toEqual({ r: 'confirmed', hand: 'confirmed', credit: 0 });
  }, 60_000);

  it('a fully applied receipt lowers nothing: it cancels while the refund has spent the customer to zero', async () => {
    const c = await L.newCustomer();
    const inv = await L.invoice(c, 300, '2026-05-01');
    const applied = await L.allocated(c, 300, '2026-05-05', 'fifo');
    await L.allocated(c, 200, '2026-05-05');
    await L.allocated(c, -200, '2026-05-10');
    expect(await L.credit(c)).toBe(0);
    expect(await verdict(voidReceipt(applied.receipt))).toBe('passed');
    const { rows: [i] } = await pool.query('SELECT amount_paid FROM customer_invoices WHERE id = $1', [inv]);
    expect({ receipt: await L.statusOf(applied.receipt), paid: Number(i.amount_paid), credit: await L.credit(c) })
      .toEqual({ receipt: 'cancelled', paid: 0, credit: 0 });
  }, 60_000);

  it('breaker R2-2: a receipt dated AFTER the refund does not hide it; that later receipt itself still cancels', async () => {
    const c = await L.newCustomer();
    const early = await L.allocated(c, 500, '2026-05-05');
    await L.allocated(c, -500, '2026-05-10');
    const later = await L.allocated(c, 500, '2026-05-20');
    expect(await L.credit(c)).toBe(500); // the all-dates figure would cover the early receipt
    expect(await verdict(reverseLine(early.line))).toBe('RECEIPT_REFUSED');
    expect(await verdict(reverseLine(later.line))).toBe('passed'); // the refund never relied on it
    expect({ early: await L.statusOf(early.receipt), later: await L.statusOf(later.receipt), credit: await L.credit(c) })
      .toEqual({ early: 'confirmed', later: 'cancelled', credit: 0 });
  }, 60_000);

  it('a cancel that lowers credit within what is left passes', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 500, '2026-05-05');
    await L.allocated(c, -200, '2026-05-10');
    await L.allocated(c, 300, '2026-05-12');
    // from 05-05: 500, 300, 600 — cancelling R500 leaves 0, -200 -> refused; the R300 one leaves 300 -> passes
    expect(await verdict(reverseLine(r.line))).toBe('RECEIPT_REFUSED');
    const { rows: [late] } = await pool.query(
      "SELECT id FROM customer_payments WHERE client_id = $1 AND total_amount = 300", [c]);
    expect(await verdict(voidReceipt(String(late.id)))).toBe('passed');
    expect(await L.credit(c)).toBe(300);
  }, 60_000);

  it('a refund holding the customer makes the cancel retryable at once — the cancel never waits on it', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 250, '2026-05-05');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [c]); // as lockContactForRefund holds it
      const started = Date.now();
      expect(await verdict(voidReceipt(r.receipt))).toBe('PAYMENT_LOCK_TIMEOUT');
      expect(Date.now() - started).toBeLessThan(4_000); // a waited lock would sit out its 5 s lock_timeout
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await L.statusOf(r.receipt)).toBe('confirmed');
    expect(await verdict(voidReceipt(r.receipt))).toBe('passed'); // the retry, once the refund is done
  }, 60_000);

  it('FAILS CLOSED: a receipt whose customer is another company\'s is refused by name — cancel and refund alike', async () => {
    const foreign = crypto.randomUUID(); // client_id is an FK on id only: a row can name another company's customer
    await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [foreign, fx.otherCompany, 'RVC foreign']);
    const receipt = await handReceipt(foreign, 200, '2026-05-05');
    for (const out of [await verdict(voidReceipt(receipt)), await verdict(L.inTx(() => cancelCustomerPayment(fx.company, receipt, fx.user)))]) {
      expect(out).toBe('RECEIPT_REFUSED');
    }
    const err = await voidReceipt(receipt).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not one of this company's customers/);
    expect(await L.statusOf(receipt)).toBe('confirmed');
    expect(await verdict(L.inTx(() => planCustomerRefund(fx.company, foreign, 50, '2026-05-10')))).toBe('SUPPLIER_REFUND_REFUSED');
  }, 60_000);
});
