/**
 * R-120 review round 2 — the writer that made WIP lines disagree with their
 * own hours and rate. `PUT /api/accounting/time-entries` (core
 * updateTimeEntry) set `hours`/`rate` on any draft entry, practice entries
 * included, and never recomputed `applied_rate`/`line_total`. Once approved,
 * such an entry is refused by WIP billing and cannot be edited, so the source
 * is closed: hours and rate of a practice entry are edited on the practice
 * timesheet, which recomputes. The refusal reaches the operator unmasked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import timeEntriesRoute from '../../pages/api/accounting/time-entries';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = randomUUID();
const user = randomUUID();
const client = randomUUID();

async function put(body: Record<string, unknown>) {
  const token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'PUT') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = body;
  req.query = {};
  req.url = '/api/accounting/time-entries';
  const out = response();
  await timeEntriesRoute(req as never, out.res as never);
  return out.state as { statusCode: number; body: { error?: { message?: string } } };
}

async function seed(practiceClient: string | null): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,
                              billable,invoiced,status,practice_client_id,applied_rate,line_total,origin)
     VALUES($1,$2,$3,'R120 edit','2026-01-05',4,250,true,false,'draft',$4,250,1000,'manual')`,
    [id, company, user, practiceClient]);
  return id;
}
const row = async (id: string) => (await pool.query(
  'SELECT hours, rate, line_total, notes FROM time_entries WHERE id=$1', [id])).rows[0];

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'R120 edit company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    "INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status) VALUES($1,$2,'R120 edit client','hourly','active')",
    [client, company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM time_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM practice_clients WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('R-120: the generic time-entry edit cannot desync a practice entry', () => {
  it.each([{ hours: 6 }, { rate: 900 }])('refuses %j on a practice entry, with the reason, and changes nothing', async (patch) => {
    const id = await seed(client);
    const out = await put({ id, ...patch });
    expect(out.statusCode).toBe(400);
    expect(String(out.body.error?.message)).toMatch(/practice timesheet/);
    expect(await row(id)).toMatchObject({ hours: '4.00', rate: '250.00', line_total: '1000.00' });
  });

  it('still edits a practice entry\'s other fields when the form resends the same hours and rate', async () => {
    // The time-tracking page sends hours (and rate) on every save.
    const id = await seed(client);
    const out = await put({ id, notes: 'R120 note', hours: 4, rate: 250 });
    expect(out.statusCode).toBe(200);
    expect((await row(id)).notes).toBe('R120 note');
  });

  it('still edits hours on a non-practice entry', async () => {
    const id = await seed(null);
    const out = await put({ id, hours: 6 });
    expect(out.statusCode).toBe(200);
    expect((await row(id)).hours).toBe('6.00');
  });
});
