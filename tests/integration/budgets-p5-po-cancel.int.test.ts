/**
 * Budgets P5-3 review r2 (breaker REPRO 2, coordinator ruling): POST /api/accounting/purchase-orders/[id]/cancel.
 * An APPROVED PO with no goods received (status still approved, no goods_received_notes row) may be cancelled by an
 * owner or admin, with a reason; its commitment leaves remaining (cancelled is not a committing status). A manager is
 * refused (403); a PO with a receipt — partially_received, received, or still approved with a rejected-only receipt —
 * is refused (400); a reason is mandatory; the cancellation is audited. Cancel racing a goods receipt on the same PO:
 * both lock the PO row, exactly one wins. Real route (withAuth → app_user), real PostgreSQL.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import { createGoodsReceived } from '@/modules/accounting/services/ap/goodsReceivedService';
import { cancelApprovedPurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderCancel';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { approvePo, cancelPo, makePo, poState } from './helpers/budgetPoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
const admin = crypto.randomUUID();

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-cancel');
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [f.co, admin]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager, admin].flatMap((u) => [`budget-remaining:${u}`, `purchase-order-approve:${u}`, `purchase-order-cancel:${u}`])]);
    await pool.query('DELETE FROM grn_items WHERE grn_id IN (SELECT id FROM goods_received_notes WHERE company_id = $1)', [f.co]);
    await pool.query('DELETE FROM goods_received_notes WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
  } finally {
    await pool.end();
  }
}, 60_000);

const committedIn = async (month: string) => {
  const r = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining',
    { lines: [{ glAccountId: f.acc.opex, cc1Id: f.cc.FT, month }] });
  return (r.body.data as { lines: Array<{ committed: number }> }).lines[0]!.committed;
};
const approvedPo = async (month: string, amount = 300) => {
  const made = await makePo(pool, f, month, [{ acct: f.acc.opex, amount, cc1: f.cc.FT }]);
  expect((await approvePo(f, f.owner, made.po)).statusCode).toBe(200);
  return made;
};
const receive = async (po: string, item: string, received: number, rejected = 0) => {
  const c = await openRequest(pool, f, f.owner);
  try {
    await c.run(() => createGoodsReceived(f.co, f.owner, {
      purchaseOrderId: po, receivedDate: '2026-06-20', items: [{ poItemId: item, quantityReceived: received, quantityRejected: rejected }],
    }));
    await c.commit();
  } finally {
    await c.rollback();
  }
};
const poAudit = async (po: string) => (await pool.query(
  "SELECT action, user_id, changes FROM audit_log WHERE entity_type = 'purchase_order' AND entity_id = $1 ORDER BY created_at", [po])).rows;

describe('cancel an approved purchase order', () => {
  it('owner or admin, with a reason: cancelled, the commitment released, audited with the reason', async () => {
    await setPolicy(pool, f, 'warn');
    const { po } = await approvedPo('2026-04', 300);
    const { po: po2 } = await approvedPo('2026-04', 200);
    expect(await committedIn('2026-04')).toBe(500);
    const r = await cancelPo(f, admin, po, { reason: '  Supplier withdrew the quote  ' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await poState(pool, po)).toMatchObject({ status: 'cancelled', updated_by: admin });
    expect(await committedIn('2026-04')).toBe(200);
    const audit = (await poAudit(po)).at(-1);
    expect(audit).toMatchObject({ action: 'update', user_id: admin });
    expect(audit.changes.fields).toEqual([{ field: 'status', old: 'approved', new: 'cancelled', label: 'Status' }]);
    expect(audit.changes.metadata).toMatchObject({ cancelled: 'true', reason: 'Supplier withdrew the quote' });
    expect((await cancelPo(f, f.owner, po2, { reason: 'Duplicate order' })).statusCode).toBe(200);
    expect(await committedIn('2026-04')).toBe(0);
  });

  it('a manager is refused (403), nothing changes', async () => {
    const { po } = await approvedPo('2026-05');
    expect((await cancelPo(f, f.manager, po, { reason: 'x' })).statusCode).toBe(403);
    expect((await poState(pool, po)).status).toBe('approved');
  });

  it('a reason is mandatory (422 blank or missing); an unknown key is 422', async () => {
    const { po } = await approvedPo('2026-05');
    for (const body of [{}, { reason: '   ' }, { reason: 'ok', status: 'cancelled' }, { reason: 'x'.repeat(2001) }]) {
      expect((await cancelPo(f, f.owner, po, body)).statusCode, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    expect((await poState(pool, po)).status).toBe('approved');
  });

  it('goods received refuses it: partially_received, received, and approved with a rejected-only receipt (400)', async () => {
    const part = await approvedPo('2026-06');
    await pool.query('UPDATE po_items SET quantity = 2 WHERE id = $1', [part.items[0]]);
    await receive(part.po, part.items[0]!, 1);
    expect((await poState(pool, part.po)).status).toBe('partially_received');
    const full = await approvedPo('2026-06');
    await receive(full.po, full.items[0]!, 1);
    expect((await poState(pool, full.po)).status).toBe('received');
    const rejected = await approvedPo('2026-06');
    await receive(rejected.po, rejected.items[0]!, 0, 1);
    expect((await poState(pool, rejected.po)).status).toBe('approved');
    for (const { po } of [part, full, rejected]) {
      const r = await cancelPo(f, f.owner, po, { reason: 'try' });
      expect(r.statusCode, po).toBe(400);
      expect(r.body.error?.message).toMatch(/goods/i);
    }
    expect((await poState(pool, rejected.po)).status).toBe('approved');
  });

  it('a draft, submitted or cancelled PO is not this action\'s (400); another company\'s is 404', async () => {
    for (const status of ['draft', 'submitted', 'cancelled']) {
      const { po } = await makePo(pool, f, '2026-07', [{ acct: f.acc.opex, amount: 1, cc1: f.cc.FT }], { status });
      expect((await cancelPo(f, f.owner, po, { reason: 'x' })).statusCode, status).toBe(400);
    }
    expect((await cancelPo(f, f.owner, crypto.randomUUID(), { reason: 'x' })).statusCode).toBe(404);
  });

  it('cancel racing a goods receipt on the same PO: exactly one wins, ×3 each order', async () => {
    for (const cancelFirst of [true, false, true, false, true, false]) {
      const { po, items } = await approvedPo('2026-08', 10);
      const c1 = await openRequest(pool, f, f.owner);
      const c2 = await openRequest(pool, f, f.owner);
      const cancel = (c: typeof c1) => c.run(() => cancelApprovedPurchaseOrder(f.co, po, f.owner, 'race'));
      const grn = (c: typeof c1) => c.run(() => createGoodsReceived(f.co, f.owner, {
        purchaseOrderId: po, receivedDate: '2026-08-20', items: [{ poItemId: items[0], quantityReceived: 1, quantityRejected: 0 }],
      }));
      const settle = (p: Promise<unknown>) => p.then(() => 'ok', () => 'refused');
      try {
        const first = await settle(cancelFirst ? cancel(c1) : grn(c1));
        const second = settle(cancelFirst ? grn(c2) : cancel(c2));
        await new Promise((r) => setTimeout(r, 200));
        await c1.commit();
        const results = [first, await second];
        await c2.commit();
        expect(results).toEqual(['ok', 'refused']);
        expect((await poState(pool, po)).status).toBe(cancelFirst ? 'cancelled' : 'received');
      } finally {
        await c1.rollback();
        await c2.rollback();
      }
    }
  }, 60_000);
});
