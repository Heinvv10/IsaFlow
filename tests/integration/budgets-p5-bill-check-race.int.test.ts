/**
 * Budgets P5-2, the block-mode lock (spec §3c, §6 T5/T6, §7; census T2), on real PostgreSQL as
 * app_user, with real concurrent transactions:
 *   1. two approvals that each fit the remaining budget alone but not together: exactly one is
 *      refused (mutation: drop the advisory lock → both approved);
 *   2. two bulk runs touching the budget keys in opposite orders, beside a single approve, ×N:
 *      no 40P01, every bill approved;
 *   3. the policy flips warn → block between the gate's read and the check's: a retryable refusal,
 *      and the retry decides under the lock;
 *   4. a refusal comes before the first write: with the payable account row held by another
 *      transaction, an over-budget approval is refused at once instead of waiting on the journal
 *      (mutation: move the check after createJournalEntry).
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkRoute from '../../pages/api/accounting/supplier-invoices-bulk-action';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { BudgetCheckLockTimeoutError, BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'race'); }, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const ui = { channel: 'ui' as const, lock: 'take' as const, reason: 'race', actorRole: 'owner' };
const ftBill = (month: string, amount: number, id?: string) =>
  makeBill(pool, f, [{ acct: f.acc.opex, amount, cc1: f.cc.FT }], { date: `${month}-15`, ...(id ? { id } : {}) });

/** Resolves when backend `pid` waits on a lock, or `p` settles first (no wait happened); false after `ms`. */
async function blockedOrSettled(pid: number, p: Promise<unknown>, ms = 4000): Promise<'blocked' | 'settled' | 'timeout'> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (settled) return 'settled';
    const r = await pool.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [pid]);
    if (r.rowCount) return 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return 'timeout';
}

const outcome = (p: Promise<unknown>) => p.then(() => 'approved', (err: unknown) => (err instanceof BudgetExceededError ? 'refused' : err));

describe('block mode: the company budget lock', () => {
  it('two concurrent approvals that fit alone but not together: exactly one is refused', async () => {
    await setPolicy(pool, f, 'block');
    const a = await ftBill('2026-04', 600);
    const b = await ftBill('2026-04', 600);
    const c1 = await openRequest(pool, f, f.owner);
    const c2 = await openRequest(pool, f, f.owner);
    try {
      const first = await outcome(c1.run(() => approveSupplierInvoice(f.co, a, f.owner, { budget: ui })));
      const second = outcome(c2.run(() => approveSupplierInvoice(f.co, b, f.owner, { budget: ui })));
      // The second must wait for the first to commit; with no lock it reads the same R1 000 and passes.
      const waited = await blockedOrSettled(c2.pid, second);
      await c1.commit();
      const results = [first, await second];
      await c2.commit();
      expect(waited).toBe('blocked');
      expect(results.sort()).toEqual(['approved', 'refused']);
      expect([(await billState(pool, a)).status, (await billState(pool, b)).status].sort()).toEqual(['approved', 'draft']);
    } finally {
      await c1.rollback();
      await c2.rollback();
    }
  });

  it('two bulk runs touching the keys in opposite orders, beside a single approve, ×5: no deadlock, all approved', async () => {
    await setPolicy(pool, f, 'block');
    for (let round = 0; round < 5; round += 1) {
      const [s1, s2, t1, t2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const [r1lo, r1hi] = [s1, s2].sort() as [string, string];
      const [r2lo, r2hi] = [t1, t2].sort() as [string, string];
      // Run 1 meets FT then travel (sorted id order); run 2 travel then FT.
      await ftBill('2027-01', 10, r1lo);
      await makeBill(pool, f, [{ acct: f.acc.travel, amount: 10 }], { date: '2027-01-15', id: r1hi });
      await makeBill(pool, f, [{ acct: f.acc.travel, amount: 10 }], { date: '2027-01-15', id: r2lo });
      await ftBill('2027-01', 10, r2hi);
      const single = await makeBill(pool, f, [{ acct: f.acc.travel, amount: 10 }], { date: '2027-01-15' });
      const URL = '/api/accounting/supplier-invoices-bulk-action';
      const [x, y, z] = await Promise.all([
        callRoute(bulkRoute as never, f, f.owner, URL, { action: 'approve', invoiceIds: [r1lo, r1hi] }),
        callRoute(bulkRoute as never, f, f.manager, URL, { action: 'approve', invoiceIds: [r2lo, r2hi] }),
        callRoute(actionRoute as never, f, f.manager, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: single }),
      ]);
      expect([x.statusCode, y.statusCode, z.statusCode], JSON.stringify([x.body, y.body, z.body])).toEqual([200, 200, 200]);
      for (const r of [x, y]) expect((r.body.data as { succeeded: number }).succeeded).toBe(2);
      for (const id of [r1lo, r1hi, r2lo, r2hi, single]) expect((await billState(pool, id)).status).toBe('approved');
    }
  }, 60_000);

  it('the policy flips warn → block between the two reads: a retryable refusal, then the retry decides under the lock', async () => {
    await setPolicy(pool, f, 'warn');
    const bill = await ftBill('2026-06', 1500);
    const holder = await pool.connect();
    const req = await openRequest(pool, f, f.owner);
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill]);
      // The gate reads warn (no lock), then the approval waits on the bill row the holder has.
      const p = req.run(() => approveSupplierInvoice(f.co, bill, f.owner, { budget: ui }));
      expect(await blockedOrSettled(req.pid, p)).toBe('blocked');
      await setPolicy(pool, f, 'block');
      await holder.query('COMMIT');
      const err = await p.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BudgetCheckLockTimeoutError);
      expect(err).toMatchObject({ code: 'BUDGET_CHECK_LOCK_TIMEOUT', policyChanged: true });
      await req.rollback();
      const retry = await callRoute(actionRoute as never, f, f.owner, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: bill });
      expect(retry.statusCode).toBe(409);
      expect(retry.body.error?.details).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    } finally {
      await holder.query('ROLLBACK'); // after the COMMIT above: a no-op (PostgreSQL warns, does not raise)
      holder.release();
      await req.rollback();
    }
  });

  it('a refusal comes before the first write: it does not wait on the journal the approval would post', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await ftBill('2026-07', 1500);
    const holder = await pool.connect();
    const req = await openRequest(pool, f, f.manager);
    try {
      await holder.query('BEGIN');
      // createJournalEntry key-shares the payable account (header guard, line FK): held here, it would wait.
      await holder.query('SELECT id FROM gl_accounts WHERE id = $1 FOR UPDATE', [f.acc.ap]);
      await req.client.query("SET LOCAL lock_timeout = '3s'");
      const err = await req.run(() => approveSupplierInvoice(f.co, bill, f.manager, { budget: { ...ui, actorRole: 'manager' } }))
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BudgetExceededError);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await req.rollback();
    }
    expect((await billState(pool, bill)).status).toBe('draft');
  });
});
