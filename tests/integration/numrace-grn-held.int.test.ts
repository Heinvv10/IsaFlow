/**
 * NUMRACE: the goods-received number lock is bounded. createGoodsReceived serialises GRN numbering on
 * hashtextextended('<company_id>', 620); it took that key with a raw pg_advisory_xact_lock, which waited with no
 * limit behind any peer holding it. It now takes the same key through take_number_lock (migration 864): a key
 * held past 5 s fails 55P03, which the route answers 503 + Retry-After, with nothing written.
 *
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import goodsReceived from '../../pages/api/accounting/goods-received';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID(), user = crypto.randomUUID(), supplier = crypto.randomUUID();
const po = crypto.randomUUID(), item = crypto.randomUUID();
let token = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'NUMRACE GRN']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'NUMRACE supplier']);
  await pool.query("INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,status) VALUES($1,$2,'PO-NR',$3,'approved')",
    [po, company, supplier]);
  await pool.query("INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'NR goods',10,5,50)",
    [item, po]);
  token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM goods_received_notes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM purchase_orders WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('a peer holding the GRN key past 5 s: the POST answers 503 + Retry-After at ~5 s, nothing written', async () => {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 620))', [company]);
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as unknown as
    { url: string; body: unknown };
  req.url = '/api/accounting/goods-received';
  req.body = { purchaseOrderId: po, receivedDate: '2026-09-08', receivedBy: 'NR',
    items: [{ poItemId: item, quantityReceived: 1, quantityRejected: 0 }] };
  const result = response();
  const t0 = Date.now();
  const pPost = goodsReceived(req as never, result.res).then(() => 'answered');
  // Before the fix the wait had no bound: release the holder after 9 s so the run ends either way.
  let outcome: string;
  try {
    outcome = await Promise.race([pPost, new Promise<string>((r) => setTimeout(() => r('still waiting at 9 s'), 9000))]);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  await pPost;
  const ms = Date.now() - t0;
  expect(outcome).toBe('answered');
  expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(503);
  expect(result.state.getHeader('retry-after')).toBe('2');
  expect(ms).toBeGreaterThanOrEqual(4500);
  expect((await pool.query('SELECT id FROM goods_received_notes WHERE company_id=$1', [company])).rows).toEqual([]);
}, 60000);
