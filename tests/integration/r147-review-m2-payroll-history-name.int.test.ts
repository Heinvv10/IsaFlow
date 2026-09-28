/**
 * R-147 review round 1, M2: the same defect as approvalService.listRequests,
 * in a sibling. `listEmployeeHistory` (payrollEmployeeHistoryService.ts)
 * LEFT JOINs `users` directly to resolve `changed_by_name`, under withAuth
 * (app_user). `users_self_read` (FORCE RLS) lets app_user SELECT only its
 * OWN row, so a viewer who is NOT the one who made the change always got a
 * blocked join — NULL name — regardless of whether the changer had a real
 * name on file. `u.first_name || ' ' || u.last_name` (plain concatenation,
 * not COALESCE) is the same second defect R-147 fixed too.
 *
 * Fixed by routing changed_by_name through the same SECURITY DEFINER
 * approval_company_member_name(company_id, user_id) (migration 714) that
 * approvalService.listRequests uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import historyHandler from '../../pages/api/payroll/employees/[id]/history';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  callRoute, cleanup, newCompany, sign,
} from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};

async function namedUser(email: string, firstName: string | null, lastName: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO users(id,email,first_name,last_name,role,is_active) VALUES($1,$2,$3,$4,$5,true)',
    [id, email, firstName, lastName, 'admin']);
  tokens[id] = await sign(id);
  users.push(id);
  return id;
}

let changer = '';
let viewer = '';

beforeAll(async () => {
  changer = await namedUser('r147-m2-changer@test.local', 'Palesa', 'Mokoena');
  viewer = await namedUser('r147-m2-viewer@test.local', 'Thabo', 'Nkosi');
});
afterAll(() => cleanup(pool, companies, users));

async function plantEmployeeWithHistory(companyId: string, changedBy: string) {
  const employeeId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id, company_id, employee_number, first_name, last_name, employment_type, start_date)
     VALUES ($1,$2,'EMP-R147-M2','Test','Employee','permanent', DATE '2026-01-01')`,
    [employeeId, companyId]);
  await pool.query(
    `INSERT INTO payroll_employee_history(company_id, employee_id, field_name, old_value, new_value, changed_by)
     VALUES ($1,$2,'department','Old Dept','New Dept',$3)`,
    [companyId, employeeId, changedBy]);
  return employeeId;
}

describe('payroll employee history resolves changed_by_name for a DIFFERENT company member (R-147 review M2)', () => {
  it('shows the real name, not null, when someone else views the history entry', async () => {
    const company = await newCompany(pool, [[changer, 'owner'], [viewer, 'owner']], companies);
    const employeeId = await plantEmployeeWithHistory(company, changer);

    const result = await callRoute(historyHandler, tokens[viewer]!, company, 'GET', undefined,
      '/api/payroll/employees/[id]/history', { id: employeeId });
    expect(result.state.statusCode).toBe(200);
    const rows = (result.state.body as { data: { changedBy: string; changedByName: string | null }[] }).data;
    const entry = rows.find((r) => r.changedBy === changer);
    expect(entry?.changedByName).toBe('Palesa Mokoena');
  });

  it('still shows the name to the changer viewing their OWN history entry', async () => {
    const company = await newCompany(pool, [[changer, 'owner'], [viewer, 'owner']], companies);
    const employeeId = await plantEmployeeWithHistory(company, changer);

    const result = await callRoute(historyHandler, tokens[changer]!, company, 'GET', undefined,
      '/api/payroll/employees/[id]/history', { id: employeeId });
    expect(result.state.statusCode).toBe(200);
    const rows = (result.state.body as { data: { changedBy: string; changedByName: string | null }[] }).data;
    const entry = rows.find((r) => r.changedBy === changer);
    expect(entry?.changedByName).toBe('Palesa Mokoena');
  });
});
