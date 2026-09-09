// K-110 adjacent cases: the extended delete guard must refuse an asset-only
// centre, still allow an unused one, leave a second tenant untouched, and be
// backed by the database itself (migration 649 makes both FKs RESTRICT).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import costCentresAction from '../../pages/api/accounting/cost-centres-action';
import { deleteCostCentre } from '../../src/modules/accounting/services/core/costCentreService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const assetCentre = crypto.randomUUID();
const unusedCentre = crypto.randomUUID();
const otherCentre = crypto.randomUUID();
const otherEmployee = crypto.randomUUID();
let token = '';

async function callDelete(id: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = { action: 'delete', id };
  req.query = {};
  req.url = '/api/accounting/cost-centres-action';
  const result = response();
  await costCentresAction(req as never, result.res);
  return result;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K110 adj fixture', other, 'K110 adj second tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    "INSERT INTO cost_centres(id,company_id,code,name,cc_type) VALUES($1,$2,'CC-ASSET','Fleet','cc1'),($3,$4,'CC-FREE','Spare','cc1'),($5,$6,'CC-OTHER','Ops','cc1')",
    [assetCentre, company, unusedCentre, company, otherCentre, other]);
  await pool.query(
    `INSERT INTO assets(company_id,asset_number,name,purchase_date,purchase_price,useful_life_years,cost_centre_id)
     VALUES($1,'A-K110','Bakkie','2026-01-01',100000,5,$2)`,
    [company, assetCentre]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,cost_centre_id)
     VALUES($1,$2,'E-K110B','Sipho','Dlamini','2026-01-01',$3)`,
    [otherEmployee, other, otherCentre]);
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM assets WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM cost_centres WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('refuses a centre that only fixed assets reference, and names the count', async () => {
  await expect(deleteCostCentre(company, assetCentre)).rejects.toThrow('1 asset(s)');
  const result = await callDelete(assetCentre);
  const rows = await pool.query('SELECT id FROM cost_centres WHERE id=$1', [assetCentre]);
  const asset = await pool.query('SELECT cost_centre_id FROM assets WHERE company_id=$1', [company]);
  expect({ status: result.state.statusCode, kept: rows.rows.length, stillAssigned: asset.rows[0].cost_centre_id })
    .toEqual({ status: 400, kept: 1, stillAssigned: assetCentre });
});

it('sends the counted refusal in the response body, not a generic Action failed', async () => {
  // badRequestFromError replaces err.message with the public string, so the
  // guard's whole point died at the route until CostCentreActionError was
  // recognised. Browser-confirmed against a dev server; asserted here.
  const result = await callDelete(assetCentre);
  const body = result.state.body as { error?: { message?: string } };
  expect(body.error?.message).toBe('Cannot delete cost centre that is used by 1 asset(s). Deactivate instead.');
});

it('still deletes a centre that nothing references', async () => {
  const result = await callDelete(unusedCentre);
  const rows = await pool.query('SELECT id FROM cost_centres WHERE id=$1', [unusedCentre]);
  expect({ status: result.state.statusCode, remaining: rows.rows.length }).toEqual({ status: 200, remaining: 0 });
});

it('leaves the second tenant untouched and cannot delete its centre', async () => {
  const result = await callDelete(otherCentre);
  const rows = await pool.query('SELECT id FROM cost_centres WHERE id=$1', [otherCentre]);
  const emp = await pool.query('SELECT cost_centre_id FROM payroll_employees WHERE id=$1', [otherEmployee]);
  expect({ kept: rows.rows.length, assignment: emp.rows[0].cost_centre_id })
    .toEqual({ kept: 1, assignment: otherCentre });
  // The scoped DELETE matches no row, and RETURNING id turns that into a 400
  // rather than the { deleted: true } it used to report.
  expect(result.state.statusCode).toBe(400);
});

it('the database refuses the delete even when the guard is bypassed', async () => {
  await expect(pool.query('DELETE FROM cost_centres WHERE id=$1', [otherCentre]))
    .rejects.toMatchObject({ code: '23503' });
});
