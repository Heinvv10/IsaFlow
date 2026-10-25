/**
 * Guard for the supplier refund ceiling (2026-10-24 review): a refund plan against an application of the same
 * supplier's cash in flight.
 *
 * On-account credit (getSupplierOnAccountCredit) = processed payments' total - allocated. Applying a payment INSERTs
 * payment_allocations and LOWERS it. A refund planned while the application is in flight must not read the R500
 * being spent as still on account. Since 2026-10-25 both hold the supplier's credit key (ap/supplierCreditLock,
 * tried, never waited on): the refund is refused as in flight (retryable, nothing written), and its retry reads the
 * committed credit and is refused on the ceiling. This parks the application AFTER its bill writes; the window
 * between its allocation INSERT and the bill write is ap-supplier-refund-vs-apply-window.int.test.ts.
 *
 * Deterministic: the application is held open after its writes; the refund's wait is found by pid (or it finishes,
 * which is the defect). Disposable fixture DB only.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { applySupplierPaymentPlan, planSupplierPaymentApplication } from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import { getSupplierOnAccountCredit, planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedBill, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';
import { lockOrderKit } from './ap-supplier-batch-lock-order.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let fx: K074Fixture;
const { startWriter, blockedStatement } = lockOrderKit(pool, () => fx.user);

beforeAll(async () => { fx = await seedK074(pool); });
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

it('a refund planned while an application of the same cash is in flight is refused, and refused again on retry', async () => {
  const bill = await seedBill(pool, fx, 1000);
  const { rows: [pay] } = await pool.query(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,reference,status,created_by)
     VALUES($1,$2,$3::DATE,500,'eft',$4,'CEIL','processed',$5) RETURNING id`, [fx.company, fx.supplier, DAY, fx.bankAccount, fx.user]);
  expect((await inTx(() => getSupplierOnAccountCredit(fx.company, fx.supplier, DAY))).credit).toBe(500);

  let applied!: () => void; let release!: () => void;
  const appliedP = new Promise<void>((res) => { applied = res; });
  const hold = new Promise<void>((res) => { release = res; });
  const applying = inTx(async () => {
    const plan = await planSupplierPaymentApplication(fx.company, String(pay.id), [{ invoiceId: bill, amount: 500 }]);
    await applySupplierPaymentPlan(fx.company, plan, fx.user);
  }, async () => { applied(); await hold; });
  await appliedP; // Y has applied all R500 and holds its locks, uncommitted

  const refund = startWriter(fx.company, () => planSupplierRefund(fx.company, fx.supplier, 500, DAY));
  // The refund is refused at once, waits on the application (by pid), or finishes beside it (the defect).
  const waited = blockedStatement(await refund.pid).then(() => true, () => false);
  await Promise.race([refund.outcome, waited]);
  release();
  await applying;
  const outcome = await refund.outcome;
  const verdict = outcome.ok ? 'passed' : outcome.code;
  const retry = await inTx(() => planSupplierRefund(fx.company, fx.supplier, 500, DAY))
    .then(() => 'passed', (e: { code?: string }) => e.code);
  const credit = (await inTx(() => getSupplierOnAccountCredit(fx.company, fx.supplier, DAY))).credit;
  expect({ verdict, retry, creditAfterApply: credit })
    .toEqual({ verdict: 'PAYMENT_LOCK_TIMEOUT', retry: 'SUPPLIER_REFUND_REFUSED', creditAfterApply: 0 });
}, 60_000);
