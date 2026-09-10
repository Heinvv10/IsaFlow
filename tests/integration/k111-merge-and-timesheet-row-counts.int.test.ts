// RED regression: K-111 — merge and time-entry actions always report zero rows.
// The `sql` tag resolves to res.rows (src/lib/neon.ts:99-111), so an UPDATE
// without RETURNING yields [] — .rowCount is undefined and .length is 0.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import duplicatesMerge from '../../pages/api/accounting/duplicates-merge';
import { submitEntries } from '../../src/modules/accounting/services/core/timeTrackingService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const primary = crypto.randomUUID();
const duplicate = crypto.randomUUID();
const entryA = crypto.randomUUID();
const entryB = crypto.randomUUID();
let token = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K111 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [primary, company, 'Acme Pty Ltd', duplicate, company, 'ACME (Pty) Ltd']);
  for (const n of ['SI-K111-1', 'SI-K111-2', 'SI-K111-3']) {
    await pool.query(
      `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,created_by,total_amount)
       VALUES($1,$2,$3,$4,'2026-08-01',$5,100)`,
      [crypto.randomUUID(), company, n, duplicate, user],
    );
  }
  for (const id of [entryA, entryB]) {
    await pool.query(
      `INSERT INTO time_entries(id,company_id,user_id,task_description,hours,status,entry_date)
       VALUES($1,$2,$3,'Fixture work',2,'draft','2026-08-01')`,
      [id, company, user],
    );
  }
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM time_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('reports the number of supplier invoices actually reassigned by a merge', async () => {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = { entityType: 'supplier', primaryId: primary, duplicateId: duplicate };
  req.query = {};
  req.url = '/api/accounting/duplicates-merge';
  const result = response();
  await duplicatesMerge(req as never, result.res);

  const moved = await pool.query(
    'SELECT count(*)::int AS n FROM supplier_invoices WHERE company_id=$1 AND supplier_id=$2', [company, primary]);
  const body = result.state.body as { data: { reassignedTransactions: number } };
  // RED: three invoices really moved, but the operator is told zero.
  expect({ actuallyMoved: moved.rows[0].n, reported: body.data.reassignedTransactions })
    .toEqual({ actuallyMoved: 3, reported: 3 });
});

it('reports the number of time entries actually submitted', async () => {
  const reported = await submitEntries(company, [entryA, entryB]);
  const submitted = await pool.query(
    "SELECT count(*)::int AS n FROM time_entries WHERE company_id=$1 AND status='submitted'", [company]);
  // RED: both entries move to submitted, but submitEntries returns 0.
  expect({ actuallySubmitted: submitted.rows[0].n, reported }).toEqual({ actuallySubmitted: 2, reported: 2 });
});
