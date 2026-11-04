/**
 * Budgets P5-3, the block-mode lock on the PO path (spec §3c; lock order: `budget_check:<company>` FIRST, then the
 * purchase_orders row), on real PostgreSQL as app_user, with real concurrent transactions:
 *   1. a PO approval and a bill approval on the same slice, each fitting the remaining budget alone but not
 *      together: exactly one is refused (mutation: drop the lock on the PO path → both approved);
 *   2. two PO approvals the same way: exactly one refused;
 *   3. PO approvals racing a bulk bill approve and a single bill approve, ×5: no 40P01, everything approved.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkRoute from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approvePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderApprove';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { approvePo, makePo, poState } from './helpers/budgetPoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-race'); }, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

const ui = { channel: 'ui' as const, lock: 'take' as const, reason: 'race', actorRole: 'owner' };
const ftPo = (month: string, amount: number) => makePo(pool, f, month, [{ acct: f.acc.opex, amount, cc1: f.cc.FT }]);

/** Resolves when backend `pid` waits on a lock, or `p` settles first (no wait happened); 'timeout' after `ms`. */
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

describe('block mode: the company budget lock on the PO path', () => {
  it('a bill approval holds the lock; a PO approval on the same slice waits, then is refused (each fits alone)', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }], { date: '2026-04-15' });
    const { po } = await ftPo('2026-04', 600);
    const c1 = await openRequest(pool, f, f.owner);
    const c2 = await openRequest(pool, f, f.owner);
    try {
      const first = await outcome(c1.run(() => approveSupplierInvoice(f.co, bill, f.owner, { budget: ui })));
      const second = outcome(c2.run(() => approvePurchaseOrder(f.co, po, f.owner, ui)));
      const waited = await blockedOrSettled(c2.pid, second);
      await c1.commit();
      const results = [first, await second];
      await c2.commit();
      expect(waited).toBe('blocked');
      expect(results).toEqual(['approved', 'refused']);
      expect((await billState(pool, bill)).status).toBe('approved');
      expect((await poState(pool, po)).status).toBe('draft');
    } finally {
      await c1.rollback();
      await c2.rollback();
    }
  });

  it('a PO approval holds the lock; a bill approval on the same slice waits, then is refused (the PO is committed)', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await ftPo('2026-05', 600);
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }], { date: '2026-05-15' });
    const c1 = await openRequest(pool, f, f.owner);
    const c2 = await openRequest(pool, f, f.owner);
    try {
      const first = await outcome(c1.run(() => approvePurchaseOrder(f.co, po, f.owner, ui)));
      const second = outcome(c2.run(() => approveSupplierInvoice(f.co, bill, f.owner, { budget: ui })));
      const waited = await blockedOrSettled(c2.pid, second);
      await c1.commit();
      const results = [first, await second];
      await c2.commit();
      expect(waited).toBe('blocked');
      expect(results).toEqual(['approved', 'refused']);
      expect((await poState(pool, po)).status).toBe('approved');
      expect((await billState(pool, bill)).status).toBe('draft');
    } finally {
      await c1.rollback();
      await c2.rollback();
    }
  });

  it('two PO approvals on one slice, each fitting alone: exactly one refused', async () => {
    await setPolicy(pool, f, 'block');
    const a = await ftPo('2026-06', 600);
    const b = await ftPo('2026-06', 600);
    const c1 = await openRequest(pool, f, f.owner);
    const c2 = await openRequest(pool, f, f.owner);
    try {
      const first = await outcome(c1.run(() => approvePurchaseOrder(f.co, a.po, f.owner, ui)));
      const second = outcome(c2.run(() => approvePurchaseOrder(f.co, b.po, f.owner, ui)));
      const waited = await blockedOrSettled(c2.pid, second);
      await c1.commit();
      const results = [first, await second];
      await c2.commit();
      expect(waited).toBe('blocked');
      expect(results).toEqual(['approved', 'refused']);
    } finally {
      await c1.rollback();
      await c2.rollback();
    }
  });

  it('PO approvals beside a bulk bill approve and a single bill approve, ×5: no deadlock, all approved', async () => {
    await setPolicy(pool, f, 'block');
    for (let round = 0; round < 5; round += 1) {
      const bills = [
        await makeBill(pool, f, [{ acct: f.acc.opex, amount: 5, cc1: f.cc.FT }], { date: '2027-01-15' }),
        await makeBill(pool, f, [{ acct: f.acc.travel, amount: 5 }], { date: '2027-01-15' }),
      ];
      const pos = [
        (await makePo(pool, f, '2027-01', [{ acct: f.acc.travel, amount: 5 }])).po,
        (await ftPo('2027-01', 5)).po,
        (await makePo(pool, f, '2027-01', [{ acct: f.acc.opex, amount: 5, cc1: f.cc.FT }, { acct: f.acc.travel, amount: 5 }])).po,
      ];
      const results = await Promise.all([
        callRoute(bulkRoute as never, f, f.owner, '/api/accounting/supplier-invoices-bulk-action', { action: 'approve', invoiceIds: bills }),
        ...pos.map((po, i) => approvePo(f, i % 2 === 0 ? f.manager : f.owner, po)),
      ]);
      expect(results.map((r) => r.statusCode), JSON.stringify(results.map((r) => r.body))).toEqual([200, 200, 200, 200]);
      expect((results[0]!.body.data as { succeeded: number }).succeeded).toBe(2);
      for (const id of bills) expect((await billState(pool, id)).status).toBe('approved');
      for (const id of pos) expect((await poState(pool, id)).status).toBe('approved');
    }
  }, 60_000);
});
