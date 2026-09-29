/**
 * R-123 — the rate-override service LEFT JOINed auth.users as app_user. No
 * migration grants app_user SELECT on auth.users (isaflow_dev has no such table
 * at all), so the override list, the create/update re-read and the staff
 * dropdown raised "permission denied" / "does not exist" through withAuth.
 * Names now come from the SECURITY DEFINER functions approval_company_member_profile
 * (715) and company_member_directory (716), which answer only for the caller's
 * own company and its members.
 *
 * Runs with NO app_user grant on auth.users, and never stubs one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import rateOverridesRoute from '../../pages/api/accounting/practice/clients/[id]/rate-overrides';
import staffRoute from '../../pages/api/accounting/practice/clients/[id]/staff';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = randomUUID();
const otherCompany = randomUUID();
const owner = randomUUID();
const staff = randomUUID();
const outsider = randomUUID();
const client = randomUUID();
const outsiderEmail = `r123-outsider-${outsider}@test.local`;
const staffEmail = `r123-staff-${staff}@test.local`;

type Reply = { statusCode: number; body: { data?: unknown; message?: string } };
let token = '';

async function call(route: typeof staffRoute, method: string, body: Record<string, unknown> = {},
  query: Record<string, string> = {}): Promise<Reply> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, method) as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = body;
  req.query = { id: client, ...query };
  req.url = `/api/accounting/practice/clients/${client}/rate-overrides`;
  const out = response();
  await route(req as never, out.res as never);
  return out.state as Reply;
}

beforeAll(async () => {
  // The premise: app_user cannot read auth.users. A fixture that grants it
  // would let the old join pass and prove nothing.
  const premise = await pool.query(`SELECT to_regclass('auth.users') IS NULL
    OR NOT has_table_privilege('app_user', 'auth.users', 'SELECT') AS ok`);
  expect(premise.rows[0].ok, 'app_user must NOT have SELECT on auth.users here').toBe(true);

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'R123 company', otherCompany, 'R123 other tenant']);
  await pool.query(
    `INSERT INTO users(id,email,first_name,last_name,role,is_active) VALUES
       ($1,$2,'Olive','Owner','admin',true), ($3,$4,'Sam','Staff','viewer',true), ($5,$6,'Xena','Outsider','admin',true)`,
    [owner, `r123-owner-${owner}@test.local`, staff, staffEmail, outsider, outsiderEmail]);
  // The caller also owns the other company: a lookup not bound to the ACTIVE
  // company would then have every reason to list that company's members too.
  await pool.query(
    "INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner'),($4,$2,'owner')",
    [company, owner, staff, otherCompany, outsider]);
  await pool.query(
    "INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status) VALUES($1,$2,'R123 client','hourly','active')",
    [client, company]);
  token = await new SignJWT({ sub: owner, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM practice_client_rate_overrides WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM practice_clients WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, staff, outsider]]);
  } finally { await pool.end(); }
});

describe('R-123: rate-override names resolve without reading auth.users', () => {
  it('the staff dropdown lists this company\'s members with names, never another company\'s', async () => {
    const out = await call(staffRoute, 'GET');
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data).toEqual(expect.arrayContaining([
      { userId: owner, email: `r123-owner-${owner}@test.local`, fullName: 'Olive Owner' },
      { userId: staff, email: staffEmail, fullName: 'Sam Staff' },
    ]));
    expect(out.body.data).toHaveLength(2);
    expect(JSON.stringify(out.body.data)).not.toContain(outsider);
  });

  it('creating an override returns the staff name, and the list and update carry it', async () => {
    const created = await call(rateOverridesRoute, 'POST', { staffUserId: staff, ratePerHour: 990, effectiveFrom: '2026-03-01' });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ staffUserId: staff, staffName: 'Sam Staff', staffEmail, ratePerHour: 990 });

    const listed = await call(rateOverridesRoute, 'GET');
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toEqual([expect.objectContaining({ staffUserId: staff, staffName: 'Sam Staff', staffEmail })]);

    const id = (created.body.data as { id: string }).id;
    const updated = await call(rateOverridesRoute, 'PUT', { ratePerHour: 1010 }, { overrideId: id });
    expect(updated.statusCode, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({ ratePerHour: 1010, staffName: 'Sam Staff', staffEmail });
  });

  it('an override naming another company\'s member never shows that member\'s name or email', async () => {
    await pool.query(
      `INSERT INTO practice_client_rate_overrides (company_id, client_id, staff_user_id, user_id, rate_per_hour, rate, effective_from)
       VALUES ($1, $2, $3, $3, 700, 700, '2026-01-01')`, [company, client, outsider]);
    const listed = await call(rateOverridesRoute, 'GET');
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    const row = (listed.body.data as { staffUserId: string }[]).find((o) => o.staffUserId === outsider);
    expect(row).toMatchObject({ staffName: null, staffEmail: null, ratePerHour: 700 });
    expect(JSON.stringify(listed.body.data)).not.toMatch(/Xena|Outsider|r123-outsider/);
  });
});
