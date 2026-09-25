/**
 * K-086 adjacent cases for POST /api/accounting/stock-adjustments.
 *
 * The RED file proves the headline claim (a count is absolute and its
 * movement is the correction). This file covers the cases around it that the
 * fix could plausibly get wrong: the untouched delta path, a count that
 * RAISES stock, a count that agrees with the shelf, a fractional count, a
 * count racing a concurrent writer, a second company's stock, and a product
 * belonging to another tenant.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import stockAdjustments from '../../pages/api/accounting/stock-adjustments';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

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

it('a fractional count keeps stock and movement in step to the cent', async () => {
  // Three decimals on purpose: the columns hold two. Rounding the count and
  // the correction separately (100 - 60.555 = 39.445 -> 39.45 while the count
  // stores 60.56) would leave stock + correction at 100.01, so the movement
  // ledger would no longer explain the stock. Both come from one cent figure.
  const result = await adjust({ productId: productA, adjustmentType: 'count', quantity: 60.555, unitCost: 1, reason: 'stocktake by weight' });
  expect(result.state.statusCode).toBe(201);
  const stock = await stockOf(productA);
  const [movement] = await movementsOf(productA);
  expect(movement?.movement_type).toBe('adjustment_out');
  expect(Math.round(((stock ?? 0) + (movement?.q ?? 0)) * 100)).toBe(10000);
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
