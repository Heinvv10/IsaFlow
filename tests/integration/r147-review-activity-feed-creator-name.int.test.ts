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
