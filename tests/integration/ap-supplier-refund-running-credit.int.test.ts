/**
 * The refund ceiling's running credit (ap/supplierOnAccountCredit `lowestFromDate`, 2026-10-25): a refund is judged
 * on the LOWEST running on-account credit from its own date on — as at its date and at every later document date —
 * so a back-dated refund cannot push any later point below zero. Edge cases from the adversarial review (round 3):
 * one day is one point, the dip in the middle binds rather than the last point, a refund dated after everything or
 * before any payment, a legitimate back-dated refund, and tenant scoping. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getSupplierOnAccountCredit, planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { getSupplierOnAccountCredits } from '@/modules/accounting/services/ap/supplierOnAccountCredit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';
import { outcomeOf } from './ap-supplier-batch-lock-order.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let fx: K074Fixture;
beforeAll(async () => { fx = await seedK074(pool); });
afterAll(async () => { try { await cleanupK074(pool, fx); } finally { await pool.end(); } });

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function supplierWithBill(): Promise<{ supplier: string; bill: string }> {
  const supplier = crypto.randomUUID();
  const bill = crypto.randomUUID();
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, fx.company, `RC ${supplier.slice(0, 6)}`]);
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,
       total_amount,amount_paid,status,created_by)
     VALUES($1,$2,$3,$4,$5::DATE - 10,$5::DATE + 20,1000,0,1000,0,'approved',$6)`,
    [bill, fx.company, supplier, `RC-${bill.slice(0, 8)}`, DAY, fx.user]);
  return { supplier, bill };
}

/** A processed payment (or, negative, a refund row as recordSupplierRefund writes it) dated `date`. */
async function posted(supplier: string, amount: number, date: string = DAY): Promise<string> {
  const { rows: [je] } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,status,created_by,fiscal_period_id,posted_at)
     VALUES($1,$2,$3::DATE,'RC payment','posted',$4,(SELECT id FROM fiscal_periods WHERE company_id = $1 LIMIT 1),NOW())
     RETURNING id`, [fx.company, `JE-RC-${crypto.randomUUID().slice(0, 8)}`, DAY, fx.user]);
  const ap = (await pool.query(
    `SELECT id FROM gl_accounts WHERE company_id = $1 AND id <> $2 ORDER BY account_code LIMIT 1`, [fx.company, fx.bankAccount])).rows[0]?.id ?? fx.bankAccount;
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id)
     VALUES($1,$2,$4,0,$5),($1,$3,0,$4,$5)`, [je.id, ap, fx.bankAccount, Math.abs(amount), fx.company]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,
       reference,status,gl_journal_entry_id,created_by,approved_by,approved_at,processed_at)
     VALUES($1,$2,$3::DATE,$4,$5,$6,'RC','processed',$7,$8,$8,NOW(),NOW()) RETURNING id`,
    [fx.company, supplier, date, amount, amount < 0 ? 'refund' : 'eft', fx.bankAccount, je.id, fx.user]);
  return String(p.id);
}

/** The refund as the bank paths take it: plan (the ceiling, under the supplier lock + credit key), then the row. */
const refund = (supplier: string, amount: number, date: string) => inTx(async () => {
  await planSupplierRefund(fx.company, supplier, amount, date);
  const { client } = als.getStore() as unknown as { client: { query: (q: string, p: unknown[]) => Promise<unknown> } };
  await client.query(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,
       reference,status,created_by,approved_by,approved_at,processed_at)
     VALUES($1,$2,$3::DATE,$4,'refund',$5,'RC refund','processed',$6,$6,NOW(),NOW())`,
    [fx.company, supplier, date, -amount, fx.bankAccount, fx.user]);
});
const creditAll = async (supplier: string) =>
  (await inTx(() => getSupplierOnAccountCredit(fx.company, supplier, null))).credit;
const verdictOf = (o: { ok: boolean; code?: string }) => (o.ok ? 'passed' : o.code);
const dayOffset = (d: string, n: number) => {
  const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
};

const r = async (s: string, amt: number, d: string) => verdictOf(await outcomeOf(refund(s, amt, d)));
const lowest = async (s: string, d: string) =>
  (await inTx(() => getSupplierOnAccountCredits(fx.company, [s], d))).get(s)!.lowestFromDate;

describe('the refund ceiling is the lowest running credit from its date on', () => {
  it('same date: two payments and a refund sharing one day are netted as one point', async () => {
    const { supplier } = await supplierWithBill();
    await posted(supplier, 600, DAY); await posted(supplier, 400, DAY);
    expect({ a: await r(supplier, 700, DAY), b: await r(supplier, 300, DAY), c: await r(supplier, 0.01, DAY),
      all: await creditAll(supplier) }).toEqual({ a: 'passed', b: 'passed', c: 'SUPPLIER_REFUND_REFUSED', all: 0 });
  }, 60_000);

  it('refund dated after every document: judged on as-at (= all dates), to the cent', async () => {
    const { supplier } = await supplierWithBill();
    await posted(supplier, 1000.01, dayOffset(DAY, -5));
    expect({ over: await r(supplier, 1000.02, dayOffset(DAY, 30)), exact: await r(supplier, 1000.01, dayOffset(DAY, 30)),
      all: await creditAll(supplier) }).toEqual({ over: 'SUPPLIER_REFUND_REFUSED', exact: 'passed', all: 0 });
  }, 60_000);

  it('refund dated before any payment: refused (nothing was on account then)', async () => {
    const { supplier } = await supplierWithBill();
    await posted(supplier, 1000, DAY);
    expect(await r(supplier, 1, dayOffset(DAY, -1))).toBe('SUPPLIER_REFUND_REFUSED');
  }, 60_000);

  it('legitimate: a back-dated refund with only positive later documents is judged on its as-at figure', async () => {
    const { supplier } = await supplierWithBill();
    await posted(supplier, 500, dayOffset(DAY, -20));
    await posted(supplier, 700, dayOffset(DAY, 10));
    expect({ v: await r(supplier, 500, dayOffset(DAY, -10)), lowAfter: await lowest(supplier, dayOffset(DAY, -10)),
      all: await creditAll(supplier) }).toEqual({ v: 'passed', lowAfter: 0, all: 700 });
  }, 60_000);

  it('a later dip, not the last point, binds: refund passes up to the dip and is refused a cent over', async () => {
    const { supplier } = await supplierWithBill();
    await posted(supplier, 1000, dayOffset(DAY, -20));
    await r(supplier, 800, DAY);                          // dip: 200 at DAY
    await posted(supplier, 5000, dayOffset(DAY, 10));     // all dates 5200
    expect({ over: await r(supplier, 200.01, dayOffset(DAY, -10)), exact: await r(supplier, 200, dayOffset(DAY, -10)),
      low: await lowest(supplier, dayOffset(DAY, -10)), all: await creditAll(supplier) })
      .toEqual({ over: 'SUPPLIER_REFUND_REFUSED', exact: 'passed', low: 0, all: 5000 });
  }, 60_000);

  it('cross-tenant: another company\'s payment naming this supplier id is not counted; an id of another tenant reads absent', async () => {
    const { supplier } = await supplierWithBill();
    // A forged row: another tenant's payment naming this supplier id (FK is to suppliers.id only).
    await pool.query(
      `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,reference,status,created_by)
       VALUES($1,$2,$3::DATE,9999,'eft','RC x','processed',$4)`, [fx.otherCompany, supplier, DAY, fx.user]);
    const forged = Number((await pool.query(`SELECT COUNT(*) n FROM supplier_payments WHERE supplier_id=$1 AND company_id=$2`, [supplier, fx.otherCompany])).rows[0].n);
    expect(forged).toBe(1);
    const foreign = await inTx(() => getSupplierOnAccountCredits(fx.otherCompany, [supplier], DAY));
    expect({ v: await r(supplier, 1, DAY), all: await creditAll(supplier), foreign: foreign.size })
      .toEqual({ v: 'SUPPLIER_REFUND_REFUSED', all: 0, foreign: 0 });
  }, 60_000);
});
