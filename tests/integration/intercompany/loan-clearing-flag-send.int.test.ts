/**
 * The dark flag `intercompany_loan_clearing` (migration 1028), the PAYER's side: with the flag off for the payer (B), none of the three sites
 * that apply B's cash to a linked bill (the apply service, processing a payment, processing a batch) sends an allocation message, and the hook
 * never reaches the definer (nothing written, nothing logged: not the definer's "sent" nor any "not sent"). With it on, the same flows send as
 * before. Only the PAYER's flag decides a send (the receiver's flag decides its accept: loan-clearing-flag-accept). The migration seeds the
 * flag dark (is_global false, in no plan), so a fresh company has it off; a flag read that fails answers off without poisoning the payment.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { log } from '@/lib/logger';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { mirrorAllocations } from '../../../src/modules/accounting/services/intercompany/allocationOutbox';
import { loanClearingEnabled } from '../../../src/modules/accounting/services/intercompany/loanClearingGate';
import { applySupplierPaymentPlan, planSupplierPaymentApplication } from '../../../src/modules/accounting/services/ap/supplierPaymentApplicationService';
import { payRoutes } from '../r035-pr5.helpers';
import { acct } from './intercompany.fixture';
import { asService, co, mirrorCleanup, tokens, U, wipeConnections } from './mirror.helpers';
import { allocSetup, allocationMessages, clearPayments, loanConnect, plantBill, plantPaid } from './allocation.helpers';
import { LOAN_CLEARING, setLoanClearing } from './loan-clearing.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const r = payRoutes(tokens);
let conn = '';

beforeAll(() => allocSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await loanConnect(pool);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
});

/** Every log call that names an allocation message (the definer's "sent" at INFO, every "not sent" / "not written"). */
const allocationLogs = (spies: ReturnType<typeof vi.spyOn>[]) =>
  spies.flatMap((s) => s.mock.calls).filter((c) => /allocation message/i.test(String(c[0])));
const spyLogs = () => (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(log, level).mockImplementation(() => undefined));

async function applyTwoLinked(): Promise<string> {
  const one = await plantBill(pool, conn);
  const two = await plantBill(pool, conn);
  const { payment } = await plantPaid(pool, one.bill, { amount: 2300, allocate: false });
  await asService(pool, U.b, co.B, async () => {
    const plan = await planSupplierPaymentApplication(co.B, payment, [{ invoiceId: one.bill, amount: 1150 }, { invoiceId: two.bill, amount: 1150 }]);
    await applySupplierPaymentPlan(co.B, plan, U.b);
  });
  return payment;
}

async function processOne(): Promise<string> {
  const { payment } = await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'draft' });
  expect((await r.payment(U.b, co.B, 'approve', payment)).state.statusCode).toBe(200);
  const res = await r.payment(U.b, co.B, 'process', payment);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return payment;
}

async function processBatch(): Promise<string> {
  const { rows: [batch] } = await pool.query(
    `INSERT INTO supplier_payment_batches(company_id, batch_date, payment_method, bank_account_id, payment_count, total_amount, created_by)
     VALUES ($1, DATE '2026-09-01', 'eft', $2, 2, 2300, $3) RETURNING id`, [co.B, acct.bLoan, U.ab]);
  await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'draft', batch: batch.id });
  await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'draft', batch: batch.id });
  expect((await r.batch(U.b, co.B, 'approve', batch.id)).state.statusCode).toBe(200);
  const res = await r.batch(U.b, co.B, 'process', batch.id);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return batch.id as string;
}

describe('flag OFF for the payer: no allocation message from any site, and the hook never reaches the definer', () => {
  it('applySupplierPaymentPlan: the payment is applied to both linked bills, zero messages, nothing about a message logged', async () => {
    await setLoanClearing(pool, [co.B], false);
    const logs = spyLogs();
    const payment = await applyTwoLinked();
    expect((await pool.query('SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = $1', [payment])).rows[0].n).toBe(2);
    expect(await allocationMessages(pool)).toHaveLength(0);
    expect(allocationLogs(logs)).toEqual([]);
  });

  it('processSupplierPayment (approve, process, through the route): processed, zero messages', async () => {
    await setLoanClearing(pool, [co.B], false);
    const logs = spyLogs();
    const payment = await processOne();
    expect((await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [payment])).rows[0].status).toBe('processed');
    expect(await allocationMessages(pool)).toHaveLength(0);
    expect(allocationLogs(logs)).toEqual([]);
  });

  it('processBatch (approve, process, through the route): processed, zero messages', async () => {
    await setLoanClearing(pool, [co.B], false);
    const logs = spyLogs();
    const batch = await processBatch();
    expect((await pool.query('SELECT status FROM supplier_payment_batches WHERE id = $1', [batch])).rows[0].status).toBe('processed');
    expect(await allocationMessages(pool)).toHaveLength(0);
    expect(allocationLogs(logs)).toEqual([]);
  });

  it('the hook called directly with an eligible allocation and a definer that would raise: nothing written, nothing logged (it never called it)', async () => {
    await setLoanClearing(pool, [co.B], false);
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const logs = spyLogs();
    await asService(pool, U.b, co.B, () => mirrorAllocations(co.B, [allocation, 'not-a-uuid']));
    expect(await allocationMessages(pool)).toHaveLength(0);
    expect(allocationLogs(logs)).toEqual([]);
    // the same call with the flag on sends it (the allocation was eligible all along) and the bad id is logged
    await setLoanClearing(pool, [co.B], true);
    await asService(pool, U.b, co.B, () => mirrorAllocations(co.B, [allocation, 'not-a-uuid']));
    expect((await allocationMessages(pool)).map((m) => m.source_doc_id)).toEqual([allocation]);
    expect(allocationLogs(logs).length).toBeGreaterThan(0);
  });
});

describe('flag ON: the same flows send exactly as before; only the PAYER\'s flag decides', () => {
  it('B on (A off: the receiver\'s flag does not stop a send): apply, process and batch each leave their messages', async () => {
    await setLoanClearing(pool, [co.A], false);
    await applyTwoLinked();
    expect(await allocationMessages(pool)).toHaveLength(2);
    await processOne();
    expect(await allocationMessages(pool)).toHaveLength(3);
    await processBatch();
    expect(await allocationMessages(pool)).toHaveLength(5);
    expect((await allocationMessages(pool)).every((m) => m.from_company_id === co.B && m.to_company_id === co.A)).toBe(true);
  });

  it('no override at all (the default) is off: B sends nothing', async () => {
    await setLoanClearing(pool, [co.B], null);
    await applyTwoLinked();
    expect(await allocationMessages(pool)).toHaveLength(0);
  });
});

describe('the flag itself', () => {
  it('the migration seeds it dark: is_global false, in no plan; a fresh company has it off (no override)', async () => {
    const flag = (await pool.query('SELECT id, is_global FROM feature_flags WHERE code = $1', [LOAN_CLEARING])).rows;
    expect(flag).toEqual([{ id: expect.any(String), is_global: false }]);
    expect((await pool.query('SELECT count(*)::int AS n FROM plan_features WHERE feature_id = $1', [flag[0].id])).rows[0].n).toBe(0);
    const fresh = crypto.randomUUID();
    await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [fresh, `IC flag fresh ${fresh.slice(0, 6)}`]);
    try {
      expect(await loanClearingEnabled(fresh)).toBe(false);
      expect(await loanClearingEnabled(co.B)).toBe(true);           // the fixture's override
    } finally {
      await pool.query('DELETE FROM companies WHERE id = $1', [fresh]);
    }
  });

  it('a flag read that fails answers off (logged by SQLSTATE only) and does not poison the payment\'s transaction', async () => {
    const { allocation, payment } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await pool.query('REVOKE SELECT ON public.feature_flags FROM app_user');
    try {
      await asService(pool, U.b, co.B, async (q) => {
        await mirrorAllocations(co.B, [allocation]);
        await q.query("UPDATE supplier_payments SET description = 'after the hook' WHERE id = $1", [payment]);
      });
    } finally {
      await pool.query('GRANT SELECT ON public.feature_flags TO app_user');
    }
    expect((await pool.query('SELECT description FROM supplier_payments WHERE id = $1', [payment])).rows[0].description).toBe('after the hook');
    expect(await allocationMessages(pool)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/loan clearing/i), { companyId: co.B, code: '42501' }, 'intercompany');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/permission denied/);
  });
});
