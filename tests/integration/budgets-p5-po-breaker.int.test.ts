/**
 * Budgets P5-3 adversarial review (PR #1114), the breaker's repros adapted, real route / real PostgreSQL as app_user:
 *   BRK-1 (M): a PO line already billed (po_item_id, approved bill) is judged at its OPEN amount
 *              (line_total − billed, remainingCommitted's figure), not its gross: block approves what never goes over.
 *   BRK-2 (ruling): an approved PO with no goods received can be cancelled (owner/admin, reason): its commitment
 *              is released. (Detail: budgets-p5-po-cancel.int.test.ts.)
 *   BRK-3: an order date outside every registry year answers 4xx, never 500 (approve and preview).
 *   BRK-4: a PUT racing an approval waits on the PO row and is refused; the approved lines stand.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, linkBillToPo, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { approvePo, cancelPo, makePo, poItems, poState, putPo } from './helpers/budgetPoFixture';
import { approvePurchaseOrder } from '@/modules/accounting/services/ap/purchaseOrderApprove';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'po-brk'); }, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager].flatMap((u) => [`budget-remaining:${u}`, `purchase-order-approve:${u}`, `purchase-order-cancel:${u}`])]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const remainingOf = async (month: string) => {
  const r = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining',
    { lines: [{ glAccountId: f.acc.opex, cc1Id: f.cc.FT, month }] });
  return (r.body.data as { lines: Array<{ committed: number; remaining: number; actual: number }> }).lines[0]!;
};
const approveBill = (bill: string) =>
  callRoute(actionRoute as never, f, f.owner, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: bill });

describe('BRK-1: a PO whose lines are already billed is judged at its gross amount, not its open commitment', () => {
  it('fully billed PO line (bill approved first): approval adds 0 committed, yet block refuses it', async () => {
    await setPolicy(pool, f, 'block');
    const { po, items } = await makePo(pool, f, '2026-09', [{ acct: f.acc.opex, amount: 800, cc1: f.cc.FT }]);
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800, cc1: f.cc.FT }], { date: '2026-09-10' });
    await linkBillToPo(pool, bill, items[0]!);
    expect((await approveBill(bill)).statusCode).toBe(200);
    expect((await billState(pool, bill)).status).toBe('approved');
    expect(await remainingOf('2026-09')).toMatchObject({ actual: 800, committed: 0, remaining: 200 });
    const preview = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining', { purchaseOrderId: po });
    expect(preview.body.data).toMatchObject({ overCount: 0 });

    const r = await approvePo(f, f.manager, po);
    // After approval the PO line is fully billed: committed stays 0, remaining stays 200 — nothing would go over.
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await remainingOf('2026-09')).toMatchObject({ committed: 0, remaining: 200 });
  });

  it('partially billed PO line: 400 billed of 1000; approval leaves remaining exactly 0, yet block refuses it', async () => {
    await setPolicy(pool, f, 'block');
    const { po, items } = await makePo(pool, f, '2026-10', [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.FT }]);
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 400, cc1: f.cc.FT }], { date: '2026-10-10' });
    await linkBillToPo(pool, bill, items[0]!);
    expect((await approveBill(bill)).statusCode).toBe(200);
    const preview = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining', { purchaseOrderId: po });
    expect(preview.body.data).toMatchObject({ overCount: 0, lines: [expect.objectContaining({ amount: 600, remaining: 600, over: false })] });
    const r = await approvePo(f, f.manager, po);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await remainingOf('2026-10')).toMatchObject({ actual: 400, committed: 600, remaining: 0 });
  });
});

describe('BRK-2: an approved PO can never release its commitment', () => {
  it('the Cancel action on an approved PO (no goods received) releases its commitment; the PUT still cannot', async () => {
    await setPolicy(pool, f, 'warn');
    const { po } = await makePo(pool, f, '2026-11', [{ acct: f.acc.opex, amount: 900, cc1: f.cc.FT }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    expect(await remainingOf('2026-11')).toMatchObject({ committed: 900, remaining: 100 });
    expect((await putPo(f, f.owner, po, { status: 'cancelled' })).statusCode).toBe(400); // approved is not editable
    const r = await cancelPo(f, f.owner, po, { reason: 'Supplier withdrew the quote' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect((await poState(pool, po)).status).toBe('cancelled');
    expect(await remainingOf('2026-11')).toMatchObject({ committed: 0, remaining: 1000 });
  });
});

describe('BRK-3: order date outside every registry year', () => {
  for (const month of ['2019-05', '2201-05']) {
    it(`a PO dated ${month} with a budgeted account: approve answers a 4xx, not 500 (block)`, async () => {
      await setPolicy(pool, f, 'block');
      const { po } = await makePo(pool, f, month, [{ acct: f.acc.opex, amount: 10, cc1: f.cc.FT }]);
      const r = await approvePo(f, f.owner, po);
      expect(r.statusCode, JSON.stringify(r.body)).toBeLessThan(500);
      const p = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining', { purchaseOrderId: po });
      expect(p.statusCode, JSON.stringify(p.body)).toBeLessThan(500);
    });
  }
});

describe('BRK-4: PUT line replacement racing an approval (block)', () => {
  it('approval holds the PO row; a PUT growing the line waits, then is refused and leaves the approved lines alone', async () => {
    await setPolicy(pool, f, 'block');
    const { po } = await makePo(pool, f, '2027-02', [{ acct: f.acc.opex, amount: 500, cc1: f.cc.FT }], { status: 'submitted' });
    const c1 = await openRequest(pool, f, f.owner);
    try {
      await c1.run(() => approvePurchaseOrder(f.co, po, f.owner, { channel: 'ui', lock: 'take', reason: null, override: false, actorRole: 'owner' }));
      const put = putPo(f, f.owner, po, { items: [{ description: 'x', quantity: 1, unit_price: 5000, tax_rate: 0, gl_account_id: f.acc.opex, cc1_id: f.cc.FT }] });
      await new Promise((r) => setTimeout(r, 500));
      await c1.commit();
      const r = await put;
      expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
      expect((await poItems(pool, po)).map((i) => i.line_total)).toEqual(['500.00']);
      expect((await poState(pool, po)).status).toBe('approved');
    } finally { await c1.rollback(); }
  });
});
