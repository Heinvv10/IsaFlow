/**
 * Budgets P5-3 r2, automated security review:
 *   S1: a PO line's checked amount is netted ONLY by linked bill lines (po_item_id, bill approved) that posted into
 *       the SAME budget slice as the PO line (account, month, member at the account's grain): a linked bill that
 *       posted to another account, another month or another slice leaves the PO line counted in full, so block mode
 *       does not under-count the PO's slice. (Same-slice netting: budgets-p5-po-breaker BRK-1.)
 *   S3: committed (P5-1's remainingCommitted) uses the SAME rule: a PO line's commitment is netted only by linked
 *       billing that posted into its own slice; off-slice billing leaves it committed in full on its slice, while the
 *       bill's actual lands on the bill's own slice. Same-slice billing nets as before.
 *   S2: a bill line's po_item_id must be a PO line of the SAME company — and of the bill's purchase_order_id when
 *       one is given — on bill create (REST, the only writer of po_item_id): 400, nothing written. Otherwise a bill
 *       could net another company's PO line.
 * Real route (withAuth → app_user), real PostgreSQL. Fixture route: isaflow_schema_fixture (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { formatMoney as R } from '@/lib/money/formatMoney';
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

describe('S1: only same-slice billing nets a PO line', () => {
  const cases: Array<[string, string, (items: string[]) => Promise<string>]> = [
    ['another account', '2026-06', async () => makeBill(pool, f, [{ acct: f.acc.travel, amount: 1000 }], { date: '2026-06-12' })],
    ['another month', '2026-07', async () => makeBill(pool, f, [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.FT }], { date: '2026-08-12' })],
    ['another slice (CC1)', '2026-09', async () => makeBill(pool, f, [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.HT }], { date: '2026-09-12' })],
  ];
  for (const [what, month, linkedBill] of cases) {
    it(`a linked bill posted to ${what} leaves the PO line counted in full: block refuses 1 000 against 700 left`, async () => {
      await setPolicy(pool, f, 'warn');
      await approveBill(await makeBill(pool, f, [{ acct: f.acc.opex, amount: 300, cc1: f.cc.FT }], { date: `${month}-05` }));
      const { po, items } = await makePo(pool, f, month, [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.FT }]);
      const bill = await linkedBill(items);
      await linkBillToPo(pool, bill, items[0]!);
      await approveBill(bill);
      expect((await billState(pool, bill)).status).toBe('approved');
      await setPolicy(pool, f, 'block');
      const r = await approvePo(f, f.manager, po);
      expect(r.statusCode, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error?.message).toContain(`remaining ${R(700)}, this order ${R(1000)}`);
    });
  }
});

describe('S3: committed is netted only by same-slice billing', () => {
  const read = async (lines: Array<Record<string, unknown>>) => {
    const r = await callRoute(remainingRoute as never, f, f.owner, '/api/accounting/budgets/remaining', { lines });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    return (r.body.data as { lines: Array<{ actual: number; committed: number; remaining: number | null }> }).lines;
  };

  it('a linked bill posted to another account: the PO slice stays committed in full; the bill\'s actual is on its own slice', async () => {
    await setPolicy(pool, f, 'warn');
    const { po, items } = await makePo(pool, f, '2026-10', [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }]);
    expect((await approvePo(f, f.owner, po)).statusCode).toBe(200);
    const bill = await makeBill(pool, f, [{ acct: f.acc.travel, amount: 450 }], { date: '2026-10-12' });
    await linkBillToPo(pool, bill, items[0]!);
    await approveBill(bill);
    const [opex, travel] = await read([{ glAccountId: f.acc.opex, cc1Id: f.cc.FT, month: '2026-10' }, { glAccountId: f.acc.travel, month: '2026-10' }]);
    expect(opex).toMatchObject({ actual: 0, committed: 600, remaining: 400 });
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
