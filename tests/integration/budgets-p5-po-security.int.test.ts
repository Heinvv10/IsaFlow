/**
 * Budgets P5-3 r2, automated security review:
 *   S1: a PO line's checked amount is netted by ALL its linked approved billing, wherever the bill posted (decision
 *       8a; coordinator ruling after breaker round 2, which showed slice-matching double counts): a PO line already
 *       billed on another account / month / slice adds nothing, so block approves it against 700 left.
 *   S3: committed uses the same formula (`openPoLineCents`): billing posted to another account releases the PO line's
 *       commitment, and the bill's actual is on the bill's own slice (checked there when the bill was approved).
 *   S2: a bill line's po_item_id must be a PO line of the SAME company — and of the bill's purchase_order_id when
 *       one is given — on bill create (REST, the only writer of po_item_id): 400, nothing written. Otherwise a bill
 *       could net another company's PO line.
 * Real route (withAuth → app_user), real PostgreSQL. Fixture route: isaflow_schema_fixture (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import billsRoute from '../../pages/api/accounting/supplier-invoices';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, linkBillToPo, makeBill, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { approvePo, makePo } from './helpers/budgetPoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-sec');
  other = await seedBillFixture(pool, 'po-sec-other');
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager].flatMap((u) => [`purchase-order-approve:${u}`, `supplier-invoice-action:${u}`, `budget-remaining:${u}`])]);
    await dropBillFixture(pool, f);
    await dropBillFixture(pool, other);
  } finally {
    await pool.end();
  }
}, 60_000);

const approveBill = async (bill: string) => {
  const r = await callRoute(actionRoute as never, f, f.owner, '/api/accounting/supplier-invoices-action',
    { action: 'approve', invoiceId: bill, budgetReason: 'setup' });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
};

describe('S1: all linked billing nets a PO line, wherever it posted', () => {
  const cases: Array<[string, string, (items: string[]) => Promise<string>]> = [
    ['another account', '2026-06', async () => makeBill(pool, f, [{ acct: f.acc.travel, amount: 1000 }], { date: '2026-06-12' })],
    ['another month', '2026-07', async () => makeBill(pool, f, [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.FT }], { date: '2026-08-12' })],
    ['another slice (CC1)', '2026-09', async () => makeBill(pool, f, [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.HT }], { date: '2026-09-12' })],
  ];
  for (const [what, month, linkedBill] of cases) {
    it(`a linked bill posted to ${what} still consumes the PO line: block approves it against 700 left`, async () => {
      await setPolicy(pool, f, 'warn');
      await approveBill(await makeBill(pool, f, [{ acct: f.acc.opex, amount: 300, cc1: f.cc.FT }], { date: `${month}-05` }));
      const { po, items } = await makePo(pool, f, month, [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.FT }]);
      const bill = await linkedBill(items);
      await linkBillToPo(pool, bill, items[0]!);
      await approveBill(bill);
      expect((await billState(pool, bill)).status).toBe('approved');
      await setPolicy(pool, f, 'block');
      const r = await approvePo(f, f.manager, po);
      expect(r.statusCode, JSON.stringify(r.body)).toBe(200); // the line is fully billed: it adds nothing
    });
  }
});

describe('S3: committed is released by linked billing wherever it posted', () => {
  const read = async (lines: Array<Record<string, unknown>>) => {
    const r = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining', { lines });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    return (r.body.data as { lines: Array<{ actual: number; committed: number; remaining: number | null }> }).lines;
  };

  it('a linked bill posted to another account releases the PO slice; the bill\'s actual is on its own slice', async () => {
    await setPolicy(pool, f, 'warn');
    const { po, items } = await makePo(pool, f, '2026-10', [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    const bill = await makeBill(pool, f, [{ acct: f.acc.travel, amount: 450 }], { date: '2026-10-12' });
    await linkBillToPo(pool, bill, items[0]!);
    await approveBill(bill);
    const [opex, travel] = await read([{ glAccountId: f.acc.opex, cc1Id: f.cc.FT, month: '2026-10' }, { glAccountId: f.acc.travel, month: '2026-10' }]);
    expect(opex).toMatchObject({ actual: 0, committed: 150, remaining: 850 });
    expect(travel).toMatchObject({ actual: 450, committed: 0, remaining: 50 });
  });

  it('a linked bill posted into the PO line\'s own slice nets its commitment as before', async () => {
    await setPolicy(pool, f, 'warn');
    const { po, items } = await makePo(pool, f, '2026-11', [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 450, cc1: f.cc.FT }], { date: '2026-11-12' });
    await linkBillToPo(pool, bill, items[0]!);
    await approveBill(bill);
    const [opex] = await read([{ glAccountId: f.acc.opex, cc1Id: f.cc.FT, month: '2026-11' }]);
    expect(opex).toMatchObject({ actual: 450, committed: 150, remaining: 400 });
  });
});

describe('S2: a bill line may name only this company\'s PO line', () => {
  const post = (items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    callRoute(billsRoute as never, f, f.owner, '/api/accounting/supplier-invoices', {
      supplierId: f.supplier, invoiceNumber: `SEC-${crypto.randomUUID().slice(0, 8)}`, invoiceDate: '2026-06-10', ...extra,
      items: items.map((i) => ({ description: 'x', quantity: 1, unitPrice: 100, taxRate: 15, glAccountId: f.acc.opex, ...i })),
    });
  const bills = async () => Number((await pool.query('SELECT count(*) FROM supplier_invoices WHERE company_id = $1', [f.co])).rows[0].count);

  it('another company\'s PO line: 400, no bill', async () => {
    const theirs = await makePo(pool, other, '2026-06', [{ acct: other.acc.opex, amount: 100 }], { status: 'approved' });
    const n = await bills();
    const r = await post([{ poItemId: theirs.items[0] }]);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/purchase order line/i);
    expect(await bills()).toBe(n);
  });

  it('a PO line of another of this company\'s POs than the bill\'s purchaseOrderId: 400; a non-uuid: 400', async () => {
    const a = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 100 }], { status: 'approved' });
    const b = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 100 }], { status: 'approved' });
    const n = await bills();
    expect((await post([{ poItemId: b.items[0] }], { purchaseOrderId: a.po })).statusCode).toBe(400);
    expect((await post([{ poItemId: 'not-a-uuid' }])).statusCode).toBe(400);
    expect(await bills()).toBe(n);
  });

  it('a PO of another supplier than the bill\'s, or a PO not approved (draft, submitted, cancelled): 400, no bill', async () => {
    const otherSupplier = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'Other supplier', true)", [otherSupplier, f.co]);
    const theirs = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 100 }], { status: 'approved' });
    await pool.query('UPDATE purchase_orders SET supplier_id = $2 WHERE id = $1', [theirs.po, otherSupplier]);
    const n = await bills();
    const r = await post([{ poItemId: theirs.items[0] }]);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/supplier/i);
    for (const status of ['draft', 'submitted', 'cancelled']) {
      const po = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 100 }], { status });
      const refused = await post([{ poItemId: po.items[0] }]);
      expect(refused.statusCode, status).toBe(400);
      expect(refused.body.error?.message, status).toMatch(/approved/i);
    }
    expect(await bills()).toBe(n);
    for (const status of ['partially_received', 'received']) {
      const po = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 100 }], { status });
      expect((await post([{ poItemId: po.items[0] }])).statusCode, status).toBe(201);
    }
  });

  it('this company\'s PO line (and its own PO as purchaseOrderId) is stored', async () => {
    const a = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 100 }], { status: 'approved' });
    for (const extra of [{}, { purchaseOrderId: a.po }]) {
      const r = await post([{ poItemId: a.items[0] }], extra);
      expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
      const id = String((r.body.data as { id: string }).id);
      expect((await pool.query('SELECT po_item_id FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [id])).rows[0].po_item_id).toBe(a.items[0]);
    }
  });
});
