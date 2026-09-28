/**
 * R-147 review round 1 — the same defect as approvalService.listRequests in
 * two more siblings: customer-activities.ts and supplier-activities.ts
 * LEFT JOINed `users` directly for created_by_email/first_name/last_name.
 * `users_self_read` (FORCE RLS) lets app_user SELECT only its own row, so a
 * viewer who did NOT create the activity always got NULL for all three
 * columns. Fixed by routing through approval_company_member_profile
 * (migration 715), a SECURITY DEFINER lookup returning the three raw parts
 * (the ActivityTab.tsx components already combine them client-side, falling
 * back to email then "Unknown" — that contract is unchanged).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerActivitiesHandler from '../../pages/api/accounting/customer-activities';
import supplierActivitiesHandler from '../../pages/api/accounting/supplier-activities';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, newCompany, sign } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};

async function namedUser(email: string, firstName: string, lastName: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO users(id,email,first_name,last_name,role,is_active) VALUES($1,$2,$3,$4,$5,true)',
    [id, email, firstName, lastName, 'admin']);
  tokens[id] = await sign(id);
  users.push(id);
  return id;
}

let creator = '';
let viewer = '';

beforeAll(async () => {
  creator = await namedUser('r147-activity-creator@test.local', 'Zanele', 'Botha');
  viewer = await namedUser('r147-activity-viewer@test.local', 'Kagiso', 'Pillay');
});
afterAll(() => cleanup(pool, companies, users));

describe('customer-activities resolves created_by name for a DIFFERENT company member (R-147 review)', () => {
  it('shows the real name, not null, when someone else lists the activity', async () => {
    const company = await newCompany(pool, [[creator, 'owner'], [viewer, 'owner']], companies);
    const customerId = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customerId, company, 'R147 Customer']);
    await pool.query(
      `INSERT INTO customer_activities(company_id,customer_id,activity_type,description,created_by)
       VALUES($1,$2,'note','R147 test note',$3)`,
      [company, customerId, creator]);

    const result = await callRoute(customerActivitiesHandler, tokens[viewer]!, company, 'GET', undefined,
      '/api/accounting/customer-activities', { customerId });
    expect(result.state.statusCode).toBe(200);
    const rows = (result.state.body as {
      data: { created_by: string; created_by_first_name: string | null; created_by_last_name: string | null; created_by_email: string | null }[];
    }).data;
    const row = rows.find((r) => r.created_by === creator);
    expect(row?.created_by_first_name).toBe('Zanele');
    expect(row?.created_by_last_name).toBe('Botha');
    expect(row?.created_by_email).toBe('r147-activity-creator@test.local');
  });
});

/** Sets the session GUCs a real withAuth request would (sub + active company), then SET ROLE app_user. */
async function asSession(client: import('pg').PoolClient, userId: string, sessionCompanyId: string): Promise<void> {
  await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId })]);
  await client.query("SELECT set_config('app.current_company_id', $1, false)", [sessionCompanyId]);
  await client.query('SET ROLE app_user');
}

/**
 * R-151 review — same two 42501 guards as 714's approval_company_member_name
 * (f16f9b347 covers those for 714, plus its own target-not-a-member case:
 * "the name lookup cannot resolve a user outside the caller's company" in
 * r147-approval-requester-name.int.test.ts, which already proves 714's
 * target-membership join with the same shape as (c) below), ported to 715's
 * table-returning sibling.
 */
describe('approval_company_member_profile refuses the two 42501 guards and the target-membership boundary (R-151 review)', () => {
  it('refuses (42501, "own company") when the session company differs from the p_company_id argument', async () => {
    const companyA = await newCompany(pool, [[creator, 'owner']], companies);
    const companyB = await newCompany(pool, [[viewer, 'owner']], companies);
    const client = await pool.connect();
    try {
      await asSession(client, creator, companyA);
      await expect(
        client.query('SELECT * FROM public.approval_company_member_profile($1, $2)', [companyB, viewer]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining("answers only for the caller's own company"),
      });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('refuses (42501, "not a member") when the session company matches p_company_id but the caller has no row there', async () => {
    // creator is deliberately NOT added as a member of companyC.
    const companyC = await newCompany(pool, [[viewer, 'owner']], companies);
    const client = await pool.connect();
    try {
      await asSession(client, creator, companyC);
      await expect(
        client.query('SELECT * FROM public.approval_company_member_profile($1, $2)', [companyC, viewer]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('caller is not a member of this company'),
      });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('returns no row for a target who is a member of a DIFFERENT company, not p_company_id', async () => {
    const company = await newCompany(pool, [[creator, 'owner']], companies);
    await newCompany(pool, [[viewer, 'owner']], companies); // viewer's only membership is elsewhere
    const client = await pool.connect();
    try {
      await asSession(client, creator, company);
      const { rows } = await client.query(
        'SELECT * FROM public.approval_company_member_profile($1, $2)', [company, viewer]);
      expect(rows).toHaveLength(0);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('returns the target\'s email/first_name/last_name when both caller and target are members (paired positive)', async () => {
    const company = await newCompany(pool, [[creator, 'owner'], [viewer, 'owner']], companies);
    const client = await pool.connect();
    try {
      await asSession(client, viewer, company);
      const { rows } = await client.query(
        'SELECT * FROM public.approval_company_member_profile($1, $2)', [company, creator]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        email: 'r147-activity-creator@test.local', first_name: 'Zanele', last_name: 'Botha',
      });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });
});

describe('supplier-activities resolves created_by name for a DIFFERENT company member (R-147 review)', () => {
  it('shows the real name, not null, when someone else lists the activity', async () => {
    const company = await newCompany(pool, [[creator, 'owner'], [viewer, 'owner']], companies);
    const supplierId = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplierId, company, 'R147 Supplier']);
    await pool.query(
      `INSERT INTO supplier_activities(company_id,supplier_id,activity_type,description,created_by)
       VALUES($1,$2,'note','R147 test note',$3)`,
      [company, supplierId, creator]);

    const result = await callRoute(supplierActivitiesHandler, tokens[viewer]!, company, 'GET', undefined,
      '/api/accounting/supplier-activities', { supplierId });
    expect(result.state.statusCode).toBe(200);
    const rows = (result.state.body as {
      data: { created_by: string; created_by_first_name: string | null; created_by_last_name: string | null; created_by_email: string | null }[];
    }).data;
    const row = rows.find((r) => r.created_by === creator);
    expect(row?.created_by_first_name).toBe('Zanele');
    expect(row?.created_by_last_name).toBe('Botha');
    expect(row?.created_by_email).toBe('r147-activity-creator@test.local');
  });
});
