/**
 * K-086 adjacent cases for POST /api/accounting/stock-adjustments.
 *
 * The RED file proves the headline claim (a count is absolute and its
 * movement is the correction). This file covers the cases around it that the
 * fix could plausibly get wrong: the untouched delta path, a count that
 * RAISES stock, a count that agrees with the shelf, a two-decimal count, a
 * refused third decimal, refused "NaN"/string/uncosted input, the value a
 * shrinkage count takes out of the valuation, the decrease clamp, a
 * transfer, a count racing a concurrent writer, cent-exact costing of a
 * half-cent product, a second company's stock and warehouse, and a product
 * belonging to another tenant.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import stockAdjustments from '../../pages/api/accounting/stock-adjustments';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { getStockValuation } from '../../src/modules/accounting/services/items/stockValuationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const admin = crypto.randomUUID();
const productA = crypto.randomUUID();
const productB = crypto.randomUUID();
let adminToken = '';

async function seedProduct(id: string, company: string, stock: number) {
  await pool.query(
    `INSERT INTO products(id,company_id,code,name,current_stock,cost_price)
     VALUES($1,$2,$3,'K086 adjacent widget',$4,25)`,
    [id, company, `K086A-${id.slice(0, 8)}`, stock],
  );
}

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'K086 adjacent A'], [companyB, 'K086 adjacent B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyA, admin]);
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
});

beforeEach(async () => {
  await pool.query('DELETE FROM stock_movements WHERE product_id = ANY($1::uuid[])', [[productA, productB]]);
  await pool.query('DELETE FROM stock_adjustments WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
  await pool.query('DELETE FROM products WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
  await seedProduct(productA, companyA, 100);
  await seedProduct(productB, companyB, 100);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM stock_movements WHERE product_id = ANY($1::uuid[])', [[productA, productB]]);
    await pool.query('DELETE FROM stock_adjustments WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM products WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[companyA, companyB]]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

function adjust(body: Record<string, unknown>, company = companyA) {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/stock-adjustments';
  req.query = {};
  req.body = body;
  const result = response();
  return stockAdjustments(req as never, result.res).then(() => result);
}

async function stockOf(id: string) {
  const { rows } = await pool.query('SELECT current_stock::float8 AS s FROM products WHERE id=$1', [id]);
  return rows[0]?.s as number | undefined;
}

async function movementsOf(id: string) {
  const { rows } = await pool.query(
    'SELECT movement_type, quantity::float8 AS q, total_cost::float8 AS c FROM stock_movements WHERE product_id=$1 ORDER BY created_at', [id]);
  return rows as Array<{ movement_type: string; q: number; c: number }>;
}

it('an increase is still a delta: 100 + 25 = 125, movement adjustment_in 25', async () => {
  const result = await adjust({ productId: productA, adjustmentType: 'increase', quantity: 25, unitCost: 4, reason: 'receipt' });
  expect(result.state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(125);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_in', q: 25, c: 100 }]);
});

it('a write_off is still a delta: 100 - 30 = 70, movement write_off 30', async () => {
  const result = await adjust({ productId: productA, adjustmentType: 'write_off', quantity: 30, unitCost: 2, reason: 'damaged' });
  expect(result.state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(70);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'write_off', q: 30, c: 60 }]);
});

it('a count ABOVE stock on hand raises it and records an inbound correction', async () => {
  const result = await adjust({ productId: productA, adjustmentType: 'count', quantity: 140, unitCost: 3, reason: 'stocktake' });
  expect(result.state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(140);
  // The correction is 40, not the 140 counted, and it is costed at 40 units.
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_in', q: 40, c: 120 }]);
});

it('a count that agrees with stock on hand moves nothing and records no movement', async () => {
  const result = await adjust({ productId: productA, adjustmentType: 'count', quantity: 100, unitCost: 3, reason: 'stocktake' });
  expect(result.state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(100);
  expect(await movementsOf(productA)).toEqual([]);
  // The count itself is still on record even though no stock moved.
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1 AND adjustment_type='count'", [companyA]);
  expect(rows[0].n).toBe(1);
});

it('a two-decimal count is exact: 100 -> 60.35 books 39.65 out, and the document agrees', async () => {
  const result = await adjust({ productId: productA, adjustmentType: 'count', quantity: 60.35, unitCost: 1, reason: 'stocktake by weight' });
  expect(result.state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(60.35);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_out', q: 39.65, c: 39.65 }]);
  const { rows } = await pool.query('SELECT quantity::float8 AS q FROM stock_adjustments WHERE company_id=$1', [companyA]);
  expect(rows).toEqual([{ q: 60.35 }]);
});

it('a third decimal is refused before anything is written', async () => {
  // Postgres rounds 1.005 to 1.01 while float cents give 1.00, so the stored
  // count and the stock it set would disagree. withAuth commits on a 4xx, so
  // the refusal has to come before the first INSERT.
  // 100.000000001 against 100 on hand: a tolerance-based check let it through
  // to a 0.00 adjustment_in, though a count that matches the shelf moves nothing.
  const inputs: Array<[string, number]> = [['count', 1.005], ['increase', 1.005], ['count', 100.000000001], ['decrease', 5.00000001]];
  for (const [adjustmentType, quantity] of inputs) {
    const result = await adjust({ productId: productA, adjustmentType, quantity, unitCost: 1, reason: 'sub-cent' });
    expect(result.state.statusCode).toBe(422);
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [companyA]);
  expect(rows[0].n).toBe(0);
  expect(await stockOf(productA)).toBe(100);
  expect(await movementsOf(productA)).toEqual([]);
});

it('"NaN", a string quantity and a count with no unit cost are refused before anything is written', async () => {
  // "NaN" is truthy and not <= 0, and NUMERIC stores NaN, which Postgres ranks
  // above 0 — so without the type check it passed the CHECK and poisoned stock.
  const bodies = [
    { adjustmentType: 'count', quantity: 'NaN', unitCost: 1 },
    { adjustmentType: 'decrease', quantity: 'NaN', unitCost: 1 },
    { adjustmentType: 'count', quantity: '60', unitCost: 1 },
    { adjustmentType: 'count', quantity: 60 },
    { adjustmentType: 'count', quantity: 60, unitCost: 'NaN' },
  ];
  for (const body of bodies) {
    const result = await adjust({ productId: productA, reason: 'bad input', ...body });
    expect(result.state.statusCode).toBe(422);
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [companyA]);
  expect(rows[0].n).toBe(0);
  expect(await stockOf(productA)).toBe(100);
  expect(await movementsOf(productA)).toEqual([]);
});

it('a shrinkage count takes its value out of the stock valuation, not just its units', async () => {
  // Start from a product whose on-hand is fully explained by movements, so the
  // valuation (which sums movements) and current_stock describe the same stock.
  await pool.query('UPDATE products SET current_stock=0 WHERE id=$1', [productA]);
  expect((await adjust({ productId: productA, adjustmentType: 'increase', quantity: 100, unitCost: 10, reason: 'receipt' })).state.statusCode).toBe(201);
  expect((await adjust({ productId: productA, adjustmentType: 'count', quantity: 60, unitCost: 10, reason: 'stocktake' })).state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(60);
  const valuation = await getStockValuation(companyA, '2999-12-31');
  const row = valuation.rows.find((r) => r.productId === productA);
  expect(row?.quantityOnHand).toBe(60);
  expect(row?.value).toBe(600);
});

it('a count and a decrease of the same 0.05 cost the same: 0.05 x 0.5 = 0.03, not a float cent off', async () => {
  // 100 - 99.95 is 0.04999999999999716 in float; times 0.5 that rounded to
  // 0.02 while a 0.05 decrease gave 0.03, and the valuation sums total_cost.
  expect((await adjust({ productId: productA, adjustmentType: 'count', quantity: 99.95, unitCost: 0.5, reason: 'stocktake' })).state.statusCode).toBe(201);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_out', q: 0.05, c: 0.03 }]);
  await pool.query('DELETE FROM stock_movements WHERE product_id=$1', [productA]);
  await pool.query('UPDATE products SET current_stock=100 WHERE id=$1', [productA]);
  expect((await adjust({ productId: productA, adjustmentType: 'decrease', quantity: 0.05, unitCost: 0.5, reason: 'shrinkage' })).state.statusCode).toBe(201);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_out', q: 0.05, c: 0.03 }]);
});

it('total_cost is multiplied in SQL NUMERIC: 0.03 x 5.5 = 0.165 -> 0.17 on a decrease and on a count', async () => {
  // In float 0.03 * 5.5 is 0.16499999999999998, which Postgres rounds to 0.16.
  // Exact-cent inputs do not save a product, only NUMERIC arithmetic does.
  expect((await adjust({ productId: productA, adjustmentType: 'decrease', quantity: 0.03, unitCost: 5.5, reason: 'shrinkage' })).state.statusCode).toBe(201);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_out', q: 0.03, c: 0.17 }]);
  await pool.query('DELETE FROM stock_movements WHERE product_id=$1', [productA]);
  await pool.query('UPDATE products SET current_stock=100 WHERE id=$1', [productA]);
  expect((await adjust({ productId: productA, adjustmentType: 'count', quantity: 99.97, unitCost: 5.5, reason: 'stocktake' })).state.statusCode).toBe(201);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_out', q: 0.03, c: 0.17 }]);
});

it('the count correction is taken in whole cents: 0.10 on hand, 0.07 counted, books 0.03 at 0.015 -> 0.02', async () => {
  // In float, 0.07*100 - 0.10*100 is -2.9999999999999991, so an un-rounded
  // correction is 0.029999999999999992 and its cost 0.0149… rounds to 0.01.
  await pool.query('UPDATE products SET current_stock=0.10 WHERE id=$1', [productA]);
  expect((await adjust({ productId: productA, adjustmentType: 'count', quantity: 0.07, unitCost: 0.5, reason: 'stocktake by weight' })).state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(0.07);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_out', q: 0.03, c: 0.02 }]);
});

it("another tenant's warehouse is refused before any row is written", async () => {
  const warehouseB = crypto.randomUUID();
  await pool.query("INSERT INTO warehouses(id,company_id,name,code) VALUES($1,$2,'K086 B store',$3)", [warehouseB, companyB, `K086-${warehouseB.slice(0, 8)}`]);
  try {
    const result = await adjust({ productId: productA, warehouseId: warehouseB, adjustmentType: 'count', quantity: 60, unitCost: 1, reason: 'wrong store' });
    expect(result.state.statusCode).toBe(404);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [companyA]);
    expect(rows[0].n).toBe(0);
    expect(await stockOf(productA)).toBe(100);
    expect(await movementsOf(productA)).toEqual([]);
  } finally {
    await pool.query('DELETE FROM warehouses WHERE id=$1', [warehouseB]);
  }
});

it("a user in BOTH companies cannot put this company's movement in the other company's warehouse", async () => {
  // RLS on warehouses admits every company the user belongs to; the
  // company_id predicate on the check is what refuses it.
  const warehouseB = crypto.randomUUID();
  await pool.query("INSERT INTO warehouses(id,company_id,name,code) VALUES($1,$2,'K086 B store',$3)", [warehouseB, companyB, `K086-${warehouseB.slice(0, 8)}`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyB, admin]);
  try {
    const result = await adjust({ productId: productA, warehouseId: warehouseB, adjustmentType: 'count', quantity: 60, unitCost: 1, reason: 'wrong store' });
    expect(result.state.statusCode).toBe(404);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [companyA]);
    expect(rows[0].n).toBe(0);
    expect(await movementsOf(productA)).toEqual([]);
  } finally {
    await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2', [companyB, admin]);
    await pool.query('DELETE FROM warehouses WHERE id=$1', [warehouseB]);
  }
});

it('an own-company warehouse is accepted and recorded on the movement', async () => {
  const warehouseA = crypto.randomUUID();
  await pool.query("INSERT INTO warehouses(id,company_id,name,code) VALUES($1,$2,'K086 A store',$3)", [warehouseA, companyA, `K086-${warehouseA.slice(0, 8)}`]);
  try {
    expect((await adjust({ productId: productA, warehouseId: warehouseA, adjustmentType: 'count', quantity: 60, unitCost: 1, reason: 'stocktake' })).state.statusCode).toBe(201);
    const { rows } = await pool.query('SELECT warehouse_id FROM stock_movements WHERE product_id=$1', [productA]);
    expect(rows).toEqual([{ warehouse_id: warehouseA }]);
  } finally {
    await pool.query('DELETE FROM stock_movements WHERE product_id=$1', [productA]);
    await pool.query('DELETE FROM stock_adjustments WHERE company_id=$1', [companyA]);
    await pool.query('DELETE FROM warehouses WHERE id=$1', [warehouseA]);
  }
});

it('a decrease past zero is still clamped at 0 and books the full requested quantity out', async () => {
  // Pre-existing semantics, kept: the clamp means movements (-150) and stock
  // (-100) disagree by 50. Recorded as a residual in K-086/fix.md.
  const result = await adjust({ productId: productA, adjustmentType: 'decrease', quantity: 150, unitCost: 1, reason: 'shrinkage' });
  expect(result.state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(0);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_out', q: 150, c: 150 }]);
});

it('a transfer is still an outbound delta', async () => {
  const result = await adjust({ productId: productA, adjustmentType: 'transfer', quantity: 20, unitCost: 1, reason: 'to branch' });
  expect(result.state.statusCode).toBe(201);
  expect(await stockOf(productA)).toBe(80);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_out', q: 20, c: 20 }]);
});

it('a count waits for a competing writer and corrects from what it then reads', async () => {
  // Two clients, interleaved by hand rather than by luck: a Promise.all of two
  // handler calls does not reliably open the window, and a race test that
  // cannot fail proves nothing. Client X holds the product row and moves it
  // from 100 to 55 while the request is in flight.
  const other = await pool.connect();
  let settled = false;
  try {
    await other.query('BEGIN');
    await other.query('SELECT current_stock FROM products WHERE id=$1 FOR UPDATE', [productA]);

    const inFlight = adjust({ productId: productA, adjustmentType: 'count', quantity: 60, unitCost: 1, reason: 'stocktake' })
      .then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Blocked on the row lock: it has read nothing yet.
    expect(settled).toBe(false);

    await other.query('UPDATE products SET current_stock=55 WHERE id=$1', [productA]);
    await other.query('COMMIT');

    const result = await inFlight;
    expect(result.state.statusCode).toBe(201);
  } finally {
    other.release();
  }

  // The count is absolute, so on hand is 60 either way. What the lock decides
  // is the CORRECTION: 60 counted against the 55 it read is +5. A handler that
  // read 100 before X committed would book a 40-unit outbound instead, and the
  // ledger would no longer explain the move from 55 to 60.
  expect(await stockOf(productA)).toBe(60);
  expect(await movementsOf(productA)).toEqual([{ movement_type: 'adjustment_in', q: 5, c: 5 }]);
});

it("a second company's product is untouched by this company's adjustment", async () => {
  await adjust({ productId: productA, adjustmentType: 'count', quantity: 10, unitCost: 1, reason: 'stocktake' });
  expect(await stockOf(productB)).toBe(100);
  expect(await movementsOf(productB)).toEqual([]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [companyB]);
  expect(rows[0].n).toBe(0);
});

it("another tenant's product is refused BEFORE any row is written (K-183)", async () => {
  const result = await adjust({ productId: productB, adjustmentType: 'increase', quantity: 5, unitCost: 1, reason: 'cross tenant' });
  expect(result.state.statusCode).toBe(404);
  // The 4xx does not roll the request transaction back, so an adjustment row
  // inserted before the ownership check would have COMMITTED against companyA.
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [companyA]);
  expect(rows[0].n).toBe(0);
  expect(await stockOf(productB)).toBe(100);
  expect(await movementsOf(productB)).toEqual([]);
});

it("a user in BOTH companies cannot adjust the other company's product from this one", async () => {
  // RLS on products admits every company the user belongs to, not only the
  // active one, so for this user RLS alone would let product B through. The
  // company_id predicate on the locking SELECT is what refuses it.
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyB, admin]);
  try {
    const result = await adjust({ productId: productB, adjustmentType: 'count', quantity: 10, unitCost: 1, reason: 'cross company' });
    expect(result.state.statusCode).toBe(404);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id = ANY($1::uuid[])', [[companyA, companyB]]);
    expect(rows[0].n).toBe(0);
    expect(await stockOf(productB)).toBe(100);
    expect(await movementsOf(productB)).toEqual([]);
  } finally {
    await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2', [companyB, admin]);
  }
});
