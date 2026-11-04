/**
 * Budgets P5-3 (spec §0 decision 8c, §2 po_items dims, T7; census items 2 and 7): the PO PUT no longer sets
 * `approved` (or the receipt statuses) — the Approve action does — and PO lines carry CC1 / CC2 / BU through the
 * create and update routes under the bill lines' rules: this company's active centres of the right kind (CC1 in the
 * CC1 slot, CC2 in the CC2 slot), CC1 derived from the CC2's FNO (a conflicting CC1 refused), and on an update a
 * dimension left out keeps the value every stored line shares. Real route (withAuth → app_user), real PostgreSQL.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import createRoute from '../../pages/api/accounting/purchase-orders';
import poRoute from '../../pages/api/accounting/purchase-orders/[id]';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { makePo, poItems, poState, putPo } from './helpers/budgetPoFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let other: BillFixture;
const proj = crypto.randomUUID();   // CC2 under FT
const projHt = crypto.randomUUID(); // CC2 under HT
const bu = crypto.randomUUID();
const deadBu = crypto.randomUUID();

beforeAll(async () => {
  f = await seedBillFixture(pool, 'po-lines');
  other = await seedBillFixture(pool, 'po-lines-other');
  await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type, parent_id) VALUES ($1, $3, 'P1', 'Project one', 'cc2', $4),
                      ($2, $3, 'P2', 'Project two', 'cc2', $5)`, [proj, projHt, f.co, f.cc.FT, f.cc.HT]);
  await pool.query(`INSERT INTO business_units (id, company_id, code, name) VALUES ($1, $3, 'OPS', 'Operations'), ($2, $3, 'OLD', 'Old')`, [bu, deadBu, f.co]);
  await pool.query('UPDATE business_units SET is_active = false WHERE id = $1', [deadBu]);
}, 60_000);
afterAll(async () => {
  try {
    await dropBillFixture(pool, f);
    await dropBillFixture(pool, other);
  } finally {
    await pool.end();
  }
}, 60_000);

const line = (o: Record<string, unknown> = {}) => ({ description: 'Widgets', quantity: 2, unit_price: 50, tax_rate: 15, gl_account_id: f.acc.opex, ...o });

describe('PUT: status', () => {
  it('status approved is refused with a 400 that points to the Approve action; nothing written', async () => {
    const { po } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 10 }]);
    const r = await putPo(f, f.owner, po, { status: 'approved', notes: 'sneak' });
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toMatch(/Approve action/);
    expect(await poState(pool, po)).toMatchObject({ status: 'draft', approved_by: null });
    expect((await pool.query('SELECT notes FROM purchase_orders WHERE id = $1', [po])).rows[0].notes).toBeNull();
  });

  it('the receipt statuses are refused too (they commit spend without an approval); draft / submitted / cancelled still go through', async () => {
    const { po } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 10 }]);
    for (const status of ['received', 'partially_received', 'paid']) {
      expect((await putPo(f, f.owner, po, { status })).statusCode, status).toBe(400);
    }
    expect((await poState(pool, po)).status).toBe('draft');
    for (const status of ['submitted', 'draft', 'cancelled']) {
      expect((await putPo(f, f.owner, po, { status })).statusCode, status).toBe(200);
      expect((await poState(pool, po)).status).toBe(status);
    }
  });
});

describe('PUT: line dimensions', () => {
  it('stores CC1 / CC2 / BU per line; a CC2 brings its FNO as CC1', async () => {
    const { po } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 10 }]);
    const r = await putPo(f, f.owner, po, { items: [line({ cc1_id: f.cc.FT, bu_id: bu }), line({ cc2_id: proj })] });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await poItems(pool, po)).toEqual([
      expect.objectContaining({ cc1_id: f.cc.FT, cc2_id: null, bu_id: bu, line_total: '100.00' }),
      expect.objectContaining({ cc1_id: f.cc.FT, cc2_id: proj, bu_id: null }),
    ]);
  });

  it('a dimension left out keeps what every stored line shares; null clears it', async () => {
    const { po } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 10, cc1: f.cc.HT, bu }]);
    expect((await putPo(f, f.owner, po, { items: [line(), line({ bu_id: null })] })).statusCode).toBe(200);
    expect((await poItems(pool, po)).map((i) => [i.cc1_id, i.bu_id])).toEqual([[f.cc.HT, bu], [f.cc.HT, null]]);
  });

  it('refused before any write (400): another company\'s centre, a CC2 in the CC1 slot, a CC1 in the CC2 slot, a CC1 its project contradicts, an inactive BU, a non-uuid', async () => {
    const { po } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 10 }]);
    const before = await poItems(pool, po);
    for (const bad of [{ cc1_id: other.cc.FT }, { cc2_id: other.cc.FT }, { cc1_id: proj }, { cc2_id: f.cc.FT },
      { cc1_id: f.cc.FT, cc2_id: projHt }, { bu_id: deadBu }, { bu_id: 'OPS' }]) {
      const r = await putPo(f, f.owner, po, { notes: 'changed', items: [line(bad)] });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await poItems(pool, po)).toEqual(before);
    expect((await pool.query('SELECT notes FROM purchase_orders WHERE id = $1', [po])).rows[0].notes).toBeNull();
  });

  it('GET labels each line\'s dimensions', async () => {
    const { po } = await makePo(pool, f, '2026-06', [{ acct: f.acc.opex, amount: 10, cc1: f.cc.FT, cc2: proj, bu }]);
    const r = await callRoute(poRoute as never, f, f.owner,
      `/api/accounting/purchase-orders/${po}`, undefined, { method: 'GET', id: po });
    expect(r.statusCode).toBe(200);
    expect((r.body.data as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({
      cc1_id: f.cc.FT, cc1_label: 'FT Fibertime', cc2_id: proj, cc2_label: 'P1 Project one', bu_id: bu, bu_label: 'OPS Operations',
    });
  });
});

describe('POST: line dimensions on a new PO', () => {
  const post = (items: Array<Record<string, unknown>>) => callRoute(createRoute as never, f, f.owner, '/api/accounting/purchase-orders',
    { supplierId: f.supplier, orderDate: '2026-06-10', items });
  const item = (o: Record<string, unknown> = {}) => ({ description: 'Bolts', quantity: 1, unitPrice: 20, taxRate: 15, ...o });

  it('stores the dimensions (a CC2 brings its FNO); the line has no account (census 7)', async () => {
    const r = await post([item({ cc2Id: proj, buId: bu }), item()]);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    const po = String((r.body.data as { id: string }).id);
    expect(await poItems(pool, po)).toEqual([
      expect.objectContaining({ gl_account_id: null, cc1_id: f.cc.FT, cc2_id: proj, bu_id: bu }),
      expect.objectContaining({ gl_account_id: null, cc1_id: null, cc2_id: null, bu_id: null }),
    ]);
  });

  it('a foreign or wrong-kind centre is 400 and no PO is created', async () => {
    const count = async () => Number((await pool.query('SELECT count(*) FROM purchase_orders WHERE company_id = $1', [f.co])).rows[0].count);
    const n = await count();
    for (const bad of [{ cc1Id: other.cc.FT }, { cc1Id: proj }, { cc2Id: f.cc.FT }]) {
      expect((await post([item(bad)])).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await count()).toBe(n);
  });
});
