/**
 * K-086 RED. POST /api/accounting/stock-adjustments, through withAuth (which
 * runs the request as app_user, withAuth.ts `SET LOCAL ROLE app_user`).
 *
 * `sign` was +1 for adjustmentType 'count', so a stocktake count was ADDED to
 * current_stock instead of replacing it, and the movement was written with the
 * counted quantity as an outbound 'adjustment_out'. It was dormant while K-085
 * rolled every adjustment back; K-085's fix (972870495, #411) made it live.
 *
 * Counted 60 against an on-hand of 100: stock must be 60 (was 160) and the
 * movement a 40-unit adjustment_out (was 60).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import stockAdjustments from '../../pages/api/accounting/stock-adjustments';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const product = crypto.randomUUID();
let adminToken = '';

beforeAll(async () => {
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'K086 stock fixture')", [company]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  await pool.query(
    `INSERT INTO products(id,company_id,code,name,current_stock,cost_price)
     VALUES($1,$2,$3,'K086 Widget',100,25)`,
    [product, company, `K086-${product.slice(0, 8)}`],
  );
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  adminToken = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(secret);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM stock_movements WHERE product_id=$1', [product]);
    await pool.query('DELETE FROM stock_adjustments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM products WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

async function adjust(body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': adminToken, active_company_id: company }, 'POST') as never as {
    url: string; body: unknown; query: Record<string, string>;
  };
  req.url = '/api/accounting/stock-adjustments';
  req.query = {};
  req.body = body;
  const result = response();
  await stockAdjustments(req as never, result.res);
  return result;
}

it('a stocktake count is accepted and recorded as one stock movement', async () => {
  const result = await adjust({ productId: product, adjustmentType: 'count', quantity: 60, unitCost: 25, reason: 'K086 stocktake' });
  expect(result.state.statusCode).toBe(201);

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM stock_movements WHERE product_id=$1', [product]);
  expect(rows[0].n).toBe(1);

  const adj = await pool.query(
    'SELECT count(*)::int AS n FROM stock_adjustments WHERE company_id=$1', [company]);
  expect(adj.rows[0].n).toBe(1);
});

it('K-086: the counted quantity replaces stock, it is not added to it', async () => {
  const { rows } = await pool.query('SELECT current_stock::float8 AS s FROM products WHERE id=$1', [product]);
  // Counted 60 against an on-hand of 100: stock becomes 60, never 160.
  expect(rows[0].s).toBe(60);
});

it('K-086: the movement carries the 40-unit correction, not the 60 counted', async () => {
  const { rows } = await pool.query(
    'SELECT movement_type, quantity::float8 AS q FROM stock_movements WHERE product_id=$1', [product]);
  expect(rows).toEqual([{ movement_type: 'adjustment_out', q: 40 }]);
});
