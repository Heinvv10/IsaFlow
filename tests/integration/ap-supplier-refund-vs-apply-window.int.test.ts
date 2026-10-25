/**
 * A supplier refund and an application of that supplier's cash share ONE figure: on-account credit
 * (getSupplierOnAccountCredit = posted payments' total - allocated). A refund may not take it below zero (the refund
 * ceiling) and, since 2026-10-25, neither may an application (Hein: refuse).
 *
 *   A (concurrent): the application has INSERTed its allocation and not yet committed. The refund used to read the
 *     cash being spent as still on account and refund it. Now it is refused while the application is in flight
 *     (retryable, nothing written: the credit key is tried, never waited on — ap/supplierCreditLock), and its retry
 *     reads the committed credit and is refused on the ceiling.
 *   B (refund first, committed or in flight): the application is refused before any write. It used to check only its
 *     own payment's remainder and leave the supplier owing the company.
 *   B (two applications against one refund): to different bills, the second is refused while the first is in
 *     flight and on retry; to one bill, it queues on the bill and is refused on the committed credit.
 *   B (back-fill): the source is skipped with its reason in the population, so dry and live runs agree.
 *
 * Interleaved deterministically (a writer parked by a wrapped export or before its COMMIT), judged by outcome; a
 * second writer that waits instead of being refused is released after 1.5 s and judged the same way.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ park: null as null | { entered: () => void; hold: Promise<void> } }));
vi.mock('@/modules/accounting/services/ap/supplierAllocationLines', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierAllocationLines')>();
  return { ...actual, applyLineToBill: async (...a: Parameters<typeof actual.applyLineToBill>) => {
    const park = gate.park;
    // After the allocation INSERT, before the bill is written: the window the refund read through.
    if (park) { gate.park = null; park.entered(); await park.hold; }
    return actual.applyLineToBill(...a);
  } };
});
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { applySupplierPaymentPlan, planSupplierPaymentApplication } from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import { getSupplierOnAccountCredit, planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { SKIP_CREDIT_CEILING } from '@/modules/accounting/services/shared/autoApplyBackfillSkips';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';
import { outcomeOf } from './ap-supplier-batch-lock-order.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let fx: K074Fixture;

beforeAll(async () => { fx = await seedK074(pool); });
beforeEach(() => { gate.park = null; });
afterAll(async () => { try { await cleanupK074(pool, fx); } finally { await pool.end(); } });

async function inTx<T>(fn: () => Promise<T>, beforeCommit: () => Promise<void> = async () => {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} } as never, fn);
    await beforeCommit();
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/** A fresh supplier of the fixture company with one open R1,000 bill (so no test reads another's credit). */
async function supplierWithBill(): Promise<{ supplier: string; bill: string }> {
  const supplier = crypto.randomUUID();
  const bill = crypto.randomUUID();
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, fx.company, `RW ${supplier.slice(0, 6)}`]);
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,
       total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,$5::DATE - 10,$5::DATE + 20,1000,0,1000,0,'approved',$6)`,
    [bill, fx.company, supplier, `RW-${bill.slice(0, 8)}`, DAY, fx.user]);
  return { supplier, bill };
}

/**
 * A processed, unapplied payment with a posted journal in the fixture's open period (or, negative, a refund document
 * as recordSupplierRefund writes it). The back-fill withholds a payment whose journal is in no period.
 */
async function posted(supplier: string, amount: number, date: string = DAY): Promise<string> {
  const { rows: [je] } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,status,created_by,fiscal_period_id,posted_at)
     VALUES($1,$2,$3::DATE,'RW payment','posted',$4,(SELECT id FROM fiscal_periods WHERE company_id = $1 LIMIT 1),NOW())
     RETURNING id`, [fx.company, `JE-RW-${crypto.randomUUID().slice(0, 8)}`, DAY, fx.user]);
  // The journal stays in the fixture's period; only the document carries `date`.
  const { rows: [p] } = await pool.query(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,
       reference,status,gl_journal_entry_id,created_by,approved_by,approved_at,processed_at)
     VALUES($1,$2,$3::DATE,$4,$5,$6,'RW','processed',$7,$8,$8,NOW(),NOW()) RETURNING id`,
    [fx.company, supplier, date, amount, amount < 0 ? 'refund' : 'eft', fx.bankAccount, je.id, fx.user]);
  return String(p.id);
}

const apply = (payment: string, bill: string, amount: number) => async () => {
  const plan = await planSupplierPaymentApplication(fx.company, payment, [{ invoiceId: bill, amount }]);
  await applySupplierPaymentPlan(fx.company, plan, fx.user);
};
const credit = async (supplier: string) =>
  (await inTx(() => getSupplierOnAccountCredit(fx.company, supplier, DAY))).credit;
const written = async (bill: string) => ({
  allocations: Number((await pool.query('SELECT COUNT(*) AS n FROM payment_allocations WHERE invoice_id = $1', [bill])).rows[0].n),
  amountPaid: Number((await pool.query('SELECT amount_paid FROM supplier_invoices WHERE id = $1', [bill])).rows[0].amount_paid),
});
const verdictOf = (o: { ok: boolean; code?: string }) => (o.ok ? 'passed' : o.code);
const settled = <T>(p: Promise<T>) => Promise.race([p, new Promise<void>((res) => setTimeout(res, 1500))]);
const IN_FLIGHT = 'PAYMENT_LOCK_TIMEOUT';

/** `first` parked in its window (`gate.park`), then `second` on its own request transaction, then `first` released. */
async function whileParked(first: () => Promise<unknown>, second: () => Promise<unknown>) {
  let entered!: () => void; let release!: () => void;
  const inWindow = new Promise<void>((res) => { entered = res; });
  gate.park = { entered, hold: new Promise<void>((res) => { release = res; }) };
  const a = outcomeOf(inTx(first));
  await inWindow;
  const b = outcomeOf(inTx(second));
  await settled(b);
  release();
  return { first: verdictOf(await a), second: verdictOf(await b) };
}

describe('A — a refund against an application of the same cash in flight', () => {
  it('is refused while the application is in flight, and on retry by the committed credit', async () => {
    const { supplier, bill } = await supplierWithBill();
    const pay = await posted(supplier, 500);
    expect(await credit(supplier)).toBe(500);
    const refund = () => planSupplierRefund(fx.company, supplier, 500, DAY);
    const race = await whileParked(apply(pay, bill, 500), refund);
    const retry = verdictOf(await outcomeOf(inTx(refund)));
    expect({ ...race, retry, credit: await credit(supplier) })
      .toEqual({ first: 'passed', second: IN_FLIGHT, retry: 'SUPPLIER_REFUND_REFUSED', credit: 0 });
  }, 60_000);
});

describe('B — an application may not take on-account credit below zero', () => {
  it('after a committed refund of that cash: refused before any write', async () => {
    const { supplier, bill } = await supplierWithBill();
    const pay = await posted(supplier, 500);
    await posted(supplier, -500);
    const outcome = await outcomeOf(inTx(apply(pay, bill, 500)));
    expect({ outcome: verdictOf(outcome), credit: await credit(supplier), ...(await written(bill)) })
      .toEqual({ outcome: 'SUPPLIER_PAYMENT_REFUSED', credit: 0, allocations: 0, amountPaid: 0 });
  }, 60_000);

  it('names the shortfall, and applies what the credit does cover', async () => {
    const { supplier, bill } = await supplierWithBill();
    const pay = await posted(supplier, 500);
    await posted(supplier, -300);
    await expect(inTx(apply(pay, bill, 500))).rejects.toThrow(/R\s500\.00.*R\s200\.00/);
    await inTx(apply(pay, bill, 200));
    expect({ credit: await credit(supplier), ...(await written(bill)) }).toEqual({ credit: 0, allocations: 1, amountPaid: 200 });
  }, 60_000);

  it('against a refund in flight: refused while it is, and on retry by the committed refund', async () => {
    const { supplier, bill } = await supplierWithBill();
    const pay = await posted(supplier, 500);
    let planned!: () => void; let release!: () => void;
    const plannedP = new Promise<void>((res) => { planned = res; });
    const hold = new Promise<void>((res) => { release = res; });
    const refunding = inTx(async () => {
      await planSupplierRefund(fx.company, supplier, 500, DAY);
      const { client } = als.getStore() as unknown as { client: { query: (q: string, p: unknown[]) => Promise<unknown> } };
      await client.query(
        `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,
           reference,status,created_by,approved_by,approved_at,processed_at)
         VALUES($1,$2,$3::DATE,-500,'refund',$4,'RW refund','processed',$5,$5,NOW(),NOW())`,
        [fx.company, supplier, DAY, fx.bankAccount, fx.user]);
    }, async () => { planned(); await hold; });
    await plannedP;
    const applying = outcomeOf(inTx(apply(pay, bill, 500)));
    await settled(applying);
    release();
    await refunding;
    const retry = verdictOf(await outcomeOf(inTx(apply(pay, bill, 500))));
    expect({ apply: verdictOf(await applying), retry, credit: await credit(supplier), ...(await written(bill)) })
      .toEqual({ apply: IN_FLIGHT, retry: 'SUPPLIER_PAYMENT_REFUSED', credit: 0, allocations: 0, amountPaid: 0 });
  }, 60_000);

  it('two applications to different bills against one refund: only one is applied', async () => {
    const { supplier, bill } = await supplierWithBill();
    const other = crypto.randomUUID();
    await pool.query(
      `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,
         total_amount,amount_paid,status,created_by)
       VALUES($1,$2,$3,$4,$5::DATE - 9,$5::DATE + 20,1000,0,1000,0,'approved',$6)`,
      [other, fx.company, supplier, `RW-${other.slice(0, 8)}`, DAY, fx.user]);
    const p1 = await posted(supplier, 500);
    const p2 = await posted(supplier, 500);
    await posted(supplier, -500); // credit R500: only one of the two may be applied
    const race = await whileParked(apply(p1, bill, 500), apply(p2, other, 500));
    const retry = verdictOf(await outcomeOf(inTx(apply(p2, other, 500))));
    expect({ ...race, retry, credit: await credit(supplier), other: await written(other) })
      .toEqual({ first: 'passed', second: IN_FLIGHT, retry: 'SUPPLIER_PAYMENT_REFUSED', credit: 0,
        other: { allocations: 0, amountPaid: 0 } });
  }, 60_000);

  it('two applications to one bill against one refund: the second queues on the bill, then is refused', async () => {
    const { supplier, bill } = await supplierWithBill();
    const p1 = await posted(supplier, 500);
    const p2 = await posted(supplier, 500);
    await posted(supplier, -500);
    const race = await whileParked(apply(p1, bill, 500), apply(p2, bill, 500));
    expect({ ...race, credit: await credit(supplier), allocations: (await written(bill)).allocations })
      .toEqual({ first: 'passed', second: 'SUPPLIER_PAYMENT_REFUSED', credit: 0, allocations: 1 });
  }, 60_000);

  it('the auto-apply back-fill skips the source with its reason, dry and live alike, and applies nothing', async () => {
    const { supplier, bill } = await supplierWithBill();
    const pay = await posted(supplier, 500);
    await posted(supplier, -500);
    const run = (dryRun: boolean) => inTx(() => autoApplyUnapplied({
      companyId: fx.company, subledger: 'ap', dryRun, userId: fx.user, entityId: supplier,
    }));
    const shape = (plan: Awaited<ReturnType<typeof run>>) => ({
      applications: plan.applications.length,
      failed: plan.failed.length,
      skipped: plan.skipped.filter((k) => k.payment_id === pay).map((k) => k.reason),
    });
    const expected = { applications: 0, failed: 0, skipped: [SKIP_CREDIT_CEILING] };
    expect(shape(await run(true))).toEqual(expected);
    expect(shape(await run(false))).toEqual(expected);
    expect({ credit: await credit(supplier), ...(await written(bill)) }).toEqual({ credit: 0, allocations: 0, amountPaid: 0 });
  }, 60_000);

  it('the back-fill applies the oldest sources the credit covers and skips the rest', async () => {
    const { supplier, bill } = await supplierWithBill();
    const older = await posted(supplier, 500);
    const newer = await posted(supplier, 300);
    await posted(supplier, -300); // credit R500: the older source fits, the newer one would take it below zero
    const plan = await inTx(() => autoApplyUnapplied({
      companyId: fx.company, subledger: 'ap', dryRun: false, userId: fx.user, entityId: supplier,
    }));
    expect({
      applied: plan.applications.map((a) => a.payment_id),
      skipped: plan.skipped.filter((k) => k.reason === SKIP_CREDIT_CEILING).map((k) => k.payment_id),
      credit: await credit(supplier),
      amountPaid: (await written(bill)).amountPaid,
    }).toEqual({ applied: [older], skipped: [newer], credit: 0, amountPaid: 500 });
  }, 60_000);
});

const dayOffset = (d: string, n: number) => {
  const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
};

describe('one credit figure across dates (adversarial review, 2026-10-25)', () => {
  /** The refund as the bank paths take it: the plan (ceiling, supplier lock, credit key), then the document. */
  const refund = (supplier: string, amount: number, date: string) => inTx(async () => {
    await planSupplierRefund(fx.company, supplier, amount, date);
    const { client } = als.getStore() as unknown as { client: { query: (q: string, p: unknown[]) => Promise<unknown> } };
    await client.query(
      `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,
         reference,status,created_by,approved_by,approved_at,processed_at)
       VALUES($1,$2,$3::DATE,$4,'refund',$5,'RW refund','processed',$6,$6,NOW(),NOW())`,
      [fx.company, supplier, date, -amount, fx.bankAccount, fx.user]);
  });
  const creditAllDates = async (supplier: string) =>
    (await inTx(() => getSupplierOnAccountCredit(fx.company, supplier, null))).creditAllDates;

  it('the same cash refunded twice, the second refund dated before the first, is refused', async () => {
    const { supplier } = await supplierWithBill();
    await posted(supplier, 1000, dayOffset(DAY, -20));
    const first = verdictOf(await outcomeOf(refund(supplier, 1000, DAY)));
    // A statement line dated earlier than the one already allocated (allocated out of date order).
    const second = verdictOf(await outcomeOf(refund(supplier, 1000, dayOffset(DAY, -10))));
    expect({ first, second, credit: await creditAllDates(supplier) })
      .toEqual({ first: 'passed', second: 'SUPPLIER_REFUND_REFUSED', credit: 0 });
  }, 60_000);

  it('a back-dated refund may not push the credit below zero at a later document date', async () => {
    const { supplier } = await supplierWithBill();
    await posted(supplier, 1000, dayOffset(DAY, -20));
    const a = verdictOf(await outcomeOf(refund(supplier, 1000, DAY)));
    await posted(supplier, 1000, dayOffset(DAY, 10)); // all-dates R1,000, but R0 as at the first refund's date
    const b = verdictOf(await outcomeOf(refund(supplier, 1000, dayOffset(DAY, -10))));
    const atA = (await inTx(() => getSupplierOnAccountCredit(fx.company, supplier, DAY))).credit;
    expect({ a, b, atA, all: await creditAllDates(supplier) })
      .toEqual({ a: 'passed', b: 'SUPPLIER_REFUND_REFUSED', atA: 0, all: 1000 });
  }, 60_000);

  it('a refund dated after today: the back-fill dry run and live run agree, and nothing is applied', async () => {
    const { supplier, bill } = await supplierWithBill();
    const pay = await posted(supplier, 500);
    await posted(supplier, -500, dayOffset(new Date().toISOString().slice(0, 10), 7));
    const run = (dryRun: boolean) => inTx(() => autoApplyUnapplied({
      companyId: fx.company, subledger: 'ap', dryRun, userId: fx.user, entityId: supplier,
    }));
    const shape = (plan: Awaited<ReturnType<typeof run>>) => ({
      applications: plan.applications.filter((a) => a.payment_id === pay).length,
      failed: plan.failed.filter((f) => f.payment_id === pay).length,
      skipped: plan.skipped.filter((k) => k.payment_id === pay).map((k) => k.reason),
    });
    const expected = { applications: 0, failed: 0, skipped: [SKIP_CREDIT_CEILING] };
    expect({ dry: shape(await run(true)), live: shape(await run(false)) }).toEqual({ dry: expected, live: expected });
    expect((await written(bill)).allocations).toBe(0);
  }, 60_000);
});
