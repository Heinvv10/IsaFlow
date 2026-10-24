/**
 * A bank-rule sweep against applying a supplier payment (40P01, found by the adversarial review of the
 * supplier-update deadlock fix).
 *
 * Sweep, one request transaction: line A is a supplier rule paying money out (recordSupplierBankPayment: its plan
 * locks supplier S's oldest bill B FOR UPDATE); line B is a supplier rule taking money in (planSupplierRefund ->
 * lockContactForRefund: S's row). Application of another processed payment of S to bill B
 * (planSupplierPaymentApplication: S FOR KEY SHARE first, then the payment, then bill B).
 * The sweep holds B and wants S; the application holds S and wants B. lockContactForRefund now takes S
 * FOR NO KEY UPDATE, which a KEY SHARE does not block.
 *
 * Interleaved deterministically (the sweep parked at line B's refund plan, the application's wait found by pid),
 * judged by outcome. Disposable fixture DB only.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedBill, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';

type Park = null | { entered: () => void; hold: Promise<void> };
const gate = vi.hoisted(() => ({ p: null as Park, x: null as Park }));
async function pass(which: 'p' | 'x') {
  const park = gate[which];
  if (park) { gate[which] = null; park.entered(); await park.hold; }
}
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentApproval', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierPaymentApproval')>();
  return { ...actual, assertPaymentApprovalCleared: async (...a: Parameters<typeof actual.assertPaymentApprovalCleared>) => {
    await pass('p'); return actual.assertPaymentApprovalCleared(...a);
  } };
});
vi.mock('@/modules/accounting/services/ap/supplierRefundDocument', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierRefundDocument')>();
  return { ...actual, planSupplierRefund: async (...a: Parameters<typeof actual.planSupplierRefund>) => {
    await pass('x'); return actual.planSupplierRefund(...a);
  } };
});

import { als } from '@/lib/als';
import { applySupplierPaymentPlan, planSupplierPaymentApplication } from '@/modules/accounting/services/ap/supplierPaymentApplicationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let fx: K074Fixture;
let expense: string;

beforeAll(async () => {
  fx = await seedK074(pool);
  expense = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
     VALUES($1,$2,'RFSWX','Refund sweep expense','expense','other','debit',true)`, [expense, fx.company]);
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [fx.company]);
    await pool.query('UPDATE supplier_payments SET gl_journal_entry_id=NULL WHERE company_id=$1', [fx.company]);
    await pool.query('UPDATE bank_transactions SET auto_post_run_id=NULL WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM bank_auto_post_runs WHERE company_id=$1', [fx.company]);
    await cleanupK074(pool, fx);
  } finally { await pool.end(); }
});

function parked(which: 'p' | 'x') {
  let release!: () => void; let entered!: () => void;
  const inGate = new Promise<void>((res) => { entered = res; });
  gate[which] = { entered, hold: new Promise<void>((res) => { release = res; }) };
  return { inGate, release };
}

async function inTx<T>(fn: (pid: number) => Promise<T>, pidOut: (pid: number) => void) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    pidOut(pid);
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} } as never, () => fn(pid));
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function waitBlockedBy(holderPid: number): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const res = await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid]);
    if (res.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`nobody ever waited on ${holderPid}`);
}

it('rule sweep (pay S from line A, refund from S on line B) vs applying another payment of S to the same bill: no 40P01', async () => {
  await pool.query("UPDATE suppliers SET auto_allocate_strategy='oldest' WHERE id=$1", [fx.supplier]);
  const bill = await seedBill(pool, fx, 1000);
  const { rows: [pay] } = await pool.query(
    `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,reference,status,created_by)
     VALUES($1,$2,$3::DATE,500,'eft',$4,'SWEEP','processed',$5) RETURNING id`, [fx.company, fx.supplier, DAY, fx.bankAccount, fx.user]);
  await pool.query(
    `INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,supplier_id,priority,auto_create_entry,vat_code)
     VALUES($1,'Sweep pay rule','description','contains','SWEEPPAY',$2,1,true,'none'),
           ($1,'Sweep refund rule','description','contains','SWEEPREF',$2,2,true,'none')`, [fx.company, fx.supplier]);
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES(gen_random_uuid(),$1,$2,$3::DATE,-300,'SWEEPPAY supplier','imported'),
           (gen_random_uuid(),$1,$2,$3::DATE,50,'SWEEPREF supplier refund','imported')`, [fx.company, fx.bankAccount, DAY]);

  // X: the real sweep, parked at line B's refund plan (line A has paid bill B and holds it).
  const x = parked('x');
  let xPid = 0;
  const handler = (await import('../../pages/api/accounting/bank-rules-action')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  const sweeping = inTx(async () => {
    await handler({ method: 'POST', body: { action: 'apply', bankAccountId: fx.bankAccount }, query: {}, companyId: fx.company,
      user: { id: fx.user } } as unknown as NextApiRequest, result.res);
    return result.state;
  }, (pid) => { xPid = pid; }).then((s) => ({ ok: true, status: s.statusCode, body: s.body }), (e: { code?: string }) => ({ ok: false, code: e.code }));
  await x.inGate;
  const held = (await pool.query('SELECT amount_paid FROM supplier_invoices WHERE id=$1', [bill])).rows[0];
  expect(Number(held.amount_paid)).toBe(0); // line A's write is not committed yet (it holds the bill)

  // Y: apply the processed payment to bill B.
  let yPid = 0;
  const applying = inTx(async () => {
    const plan = await planSupplierPaymentApplication(fx.company, String(pay.id), [{ invoiceId: bill, amount: 100 }]);
    await applySupplierPaymentPlan(fx.company, plan, fx.user);
  }, (pid) => { yPid = pid; }).then(() => ({ ok: true }), (e: { code?: string; message?: string; name?: string }) =>
    ({ ok: false, code: e.code, name: e.name, message: e.message }));
  await waitBlockedBy(xPid); // Y waits on bill B
  x.release();
  const [applied, sweep] = await Promise.all([applying, sweeping]);
  const data = ((sweep as { body?: { data?: Record<string, unknown> } }).body?.data ?? {}) as Record<string, unknown>;
  expect(yPid).toBeGreaterThan(0);
  expect({ applied, sweepOk: sweep.ok, skippedLocked: data.autoPostSkippedLocked })
    .toEqual({ applied: { ok: true }, sweepOk: true, skippedLocked: 0 });
}, 60_000);
