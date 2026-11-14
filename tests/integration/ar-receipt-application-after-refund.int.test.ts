/**
 * Receipt APPLICATION after refund (Hein, 2026-11-14, review round 1 HIGH 1): applying an existing receipt's unapplied
 * remainder that a customer refund has already returned is refused before any write, by the same rule and under the
 * same customer lock as a cancellation (`ar/customerVoidCredit.assertReceiptApplicationKeepsCredit`, called from
 * `planReceiptApplication`): REST customer-allocations, MCP `apply_receipt_to_invoice` (dry run = live) and the
 * auto-apply back-fill (`auto_apply_unapplied`, decided in its population). A receipt recorded in the same request
 * (bank allocation with FIFO) lowers nothing and is never refused. The customer row is where a refund, an application
 * and a cancellation of one customer's cash meet (breaker MEDIUM 3). Breaker repro A of eba1b81995 (red there).
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { planReceiptApplication, applyReceiptPlan } from '@/modules/accounting/services/ar/receiptApplicationService';
import { applyReceiptToInvoiceTool } from '@/lib/mcp/tools/writeApplyReceipt';
import { voidReceiptTool } from '@/lib/mcp/tools/writeVoidPayments';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { SKIP_RECEIPT_CREDIT_CEILING } from '@/modules/accounting/services/shared/autoApplyBackfillReceiptCredit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, type K074Fixture } from './helpers/k074Fixture';
import { receiptLedger, verdict } from './ar-receipt-void-after-refund.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let fx: K074Fixture;
const L = receiptLedger(pool, () => fx);
beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => { try { await cleanupK074(pool, fx); } finally { await pool.end(); } });

const plan = (receipt: string, invoiceId: string, amount: number) =>
  planReceiptApplication(fx.company, receipt, [{ invoiceId, amount }]);
const apply = (receipt: string, invoiceId: string, amount: number) => L.inTx(async () =>
  applyReceiptPlan(fx.company, await plan(receipt, invoiceId, amount), fx.user));
const applyTool = (receipt: string, invoiceId: string, amount: number, dryRun: boolean) => L.inTx(() =>
  applyReceiptToInvoiceTool.handler({ payment_id: receipt, allocations: [{ invoice_id: invoiceId, amount }],
    idempotency_key: crypto.randomUUID(), ...(dryRun ? { dry_run: true } : {}) }, L.ctx()));
const applied = async (invoiceId: string) =>
  Number((await pool.query('SELECT amount_paid FROM customer_invoices WHERE id = $1', [invoiceId])).rows[0].amount_paid);

/** A refund row with no cash behind it (legacy data, as Velocity's AP has): the customer below zero from `date`. */
async function legacyRefund(customer: string, amount: number, date: string) {
  await pool.query(`INSERT INTO customer_payments(company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
    VALUES($1,$2,$3::DATE,$4,'refund','confirmed',$5)`, [fx.company, customer, date, -amount, fx.user]);
}

/** `fn` on its own request transaction, held open until `release` resolves; `pid` is its backend. */
function holdOpen(fn: () => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let gotPid!: (n: number) => void;
  const pid = new Promise<number>((r) => { gotPid = r; });
  const done = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      gotPid((await client.query('SELECT pg_backend_pid() AS p')).rows[0].p);
      await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} } as never, fn);
      await gate;
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  })();
  return { pid, release, done };
}
async function waitsOnLock(pid: number): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    const { rowCount } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]);
    if (rowCount) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('applying a receipt whose cash a refund has returned', () => {
  it('breaker A: the application (REST customer-allocations path) is refused; the running credit is untouched', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 200, '2026-05-02');
    await L.allocated(c, -150, '2026-05-04');
    const inv = await L.invoice(c, 200, '2026-05-01');
    expect(await verdict(apply(r.receipt, inv, 200))).toBe('RECEIPT_REFUSED');
    expect(await verdict(apply(r.receipt, inv, 50))).toBe('passed'); // what is still on account
    expect({ paid: await applied(inv), credit: await L.credit(c) }).toEqual({ paid: 50, credit: 0 });
  }, 60_000);

  it('apply_receipt_to_invoice refuses in its dry run exactly as live, naming the figures', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 300, '2026-05-02');
    await L.allocated(c, -300, '2026-05-06');
    const inv = await L.invoice(c, 300, '2026-05-01');
    const dry = await applyTool(r.receipt, inv, 300, true);
    const live = await applyTool(r.receipt, inv, 300, false);
    for (const out of [dry, live]) {
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/^Applying R\s?300\.00 of this receipt would leave RVC \w+ owing the company: .* from 2026-05-02/);
    }
    expect(await applied(inv)).toBe(0);
  }, 60_000);

  it('a receipt recorded and applied in the same request lowers nothing: allowed for a customer already below zero', async () => {
    const c = await L.newCustomer();
    await legacyRefund(c, 100, '2026-05-27');
    const inv = await L.invoice(c, 300, '2026-05-01');
    expect(await verdict(L.allocated(c, 300, '2026-05-05', 'fifo'))).toBe('passed');
    expect({ paid: await applied(inv), credit: await L.credit(c) }).toEqual({ paid: 300, credit: -100 });
  }, 60_000);

  it('auto_apply_unapplied skips the receipt in its population — the dry run and the live run report the same', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 400, '2026-05-02');
    await L.allocated(c, -400, '2026-05-08');
    const inv = await L.invoice(c, 400, '2026-05-01');
    const run = (dryRun: boolean) => L.inTx(() => autoApplyUnapplied({
      companyId: fx.company, subledger: 'ar', entityId: c, dryRun, userId: fx.user }));
    for (const out of [await run(true), await run(false)]) {
      expect(out.skipped.filter((s) => s.payment_id === r.receipt).map((s) => s.reason)).toEqual([SKIP_RECEIPT_CREDIT_CEILING]);
      expect({ applications: out.applications.length, failed: out.failed }).toEqual({ applications: 0, failed: [] });
    }
    expect(await applied(inv)).toBe(0);
  }, 60_000);

  it('MEDIUM 3: a refund waits for an application in flight on the customer row, then reads what it applied', async () => {
    const c = await L.newCustomer();
    const r = await L.allocated(c, 500, '2026-05-02');
    const inv = await L.invoice(c, 500, '2026-05-01');
    const app = holdOpen(async () => applyReceiptPlan(fx.company, await plan(r.receipt, inv, 500), fx.user));
    await app.pid;
    await new Promise((res) => setTimeout(res, 200)); // the plan has taken the customer (tried) and applied
    const line = crypto.randomUUID();
    await pool.query(`INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
      VALUES($1,$2,$3,'2026-05-06',-500,'RVC refund','imported')`, [line, fx.company, fx.bankAccount]);
    const refund = holdOpen(() => allocateTransaction(fx.company, line, null, fx.user, 'RVC', 'customer', c,
      undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' }));
    refund.done.catch(() => undefined); // judged below, after the application commits
    expect(await waitsOnLock(await refund.pid)).toBe(true); // FOR UPDATE blocked by the application's NO KEY UPDATE
    app.release();
    await app.done;
    refund.release();
    expect(await verdict(refund.done)).toBe('SUPPLIER_REFUND_REFUSED'); // the one refund refusal class, both sides
    expect({ paid: await applied(inv), credit: await L.credit(c) }).toEqual({ paid: 500, credit: 0 });
  }, 60_000);

  it('MEDIUM 3: an application and a cancel of the same customer\'s cash do not both proceed — the second is retryable', async () => {
    const c = await L.newCustomer();
    const r1 = await L.allocated(c, 200, '2026-05-02');
    const r2 = await L.allocated(c, 200, '2026-05-03');
    const inv = await L.invoice(c, 200, '2026-05-01');
    const app = holdOpen(async () => applyReceiptPlan(fx.company, await plan(r1.receipt, inv, 200), fx.user));
    await app.pid;
    await new Promise((res) => setTimeout(res, 200));
    const started = Date.now();
    expect(await verdict(L.inTx(() => voidReceiptTool.handler({ receipt_id: r2.receipt, idempotency_key: crypto.randomUUID() }, L.ctx()))))
      .toBe('PAYMENT_LOCK_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(4_000);
    app.release();
    await app.done;
    expect([await L.statusOf(r2.receipt), await applied(inv)]).toEqual(['confirmed', 200]);
  }, 60_000);
});
