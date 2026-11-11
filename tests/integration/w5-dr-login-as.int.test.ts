/**
 * Wave 5 DR, #1266 round 1 S-M1 and round 2 M2/L2: approving a directive (any type), and creating, changing, cancelling or
 * deleting a fixed-percentage / fixed-amount one, sets an employee's PAYE, so a "Login as" session is refused 403 IMPERSONATION_FORBIDDEN with nothing
 * written; the target's own session is not refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import directives from '../../pages/api/accounting/tax-directives';
import directive from '../../pages/api/accounting/tax-directives/[id]';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf, type Jar } from './r-032-login-as.helpers';
import { seedPayrollCompany } from './w3-01-payroll.helpers';
import { insertDirective } from './w5-dr.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'DR Login-as');
let employee = '';
let loginAs: Jar;

beforeAll(async () => {
  await fx.setUp();
  await seedPayrollCompany(pool, fx.company);
  employee = String((await pool.query('SELECT id FROM payroll_employees WHERE company_id = $1', [fx.company])).rows[0]!.id);
  loginAs = await fx.loginAsTarget();
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM tax_directives WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1', [employee]);
    await pool.query('DELETE FROM payroll_components WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [fx.company]);
    await fx.tearDown();
  } finally { await pool.end(); }
});

const snapshot = async () => (await pool.query(
  'SELECT id, status, expiry_date::text AS expiry FROM tax_directives WHERE company_id = $1 ORDER BY id', [fx.company])).rows;
const create = (jar: Jar) => fx.call(directives, jar, { body: {
  employee_id: employee, directive_type: 'fixed_percentage', tax_rate: 0.2, effective_date: '2026-03-01', directive_number: '1234567',
} });
const patch = (jar: Jar, id: string, body: Record<string, unknown>) => fx.call(directive, jar, { method: 'PATCH', query: { id }, body });

describe('Login-as is refused on every directive write that sets PAYE', () => {
  it('create a fixed-percentage directive: 403, nothing written', async () => {
    const before = await snapshot();
    const r = await create(loginAs);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['approve a regular-pay directive', 'fixed_percentage', { status: 'approved' }],
    ['approve a lump-sum directive', 'severance', { status: 'approved' }],
    ['set an expiry date', 'fixed_percentage', { expiry_date: '2026-08-31' }],
    ['cancel an approved regular-pay directive', 'fixed_percentage', { status: 'cancelled' }],
  ])('%s: 403, nothing written', async (_name, type, body) => {
    const id = type === 'severance'
      ? String((await pool.query(
        `INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, amount, tax_rate, effective_date, status)
         VALUES ($1, $2, 'Wanda Test', 'severance', 10000, 0.1, '2026-03-01', 'pending') RETURNING id`, [fx.company, employee])).rows[0]!.id)
      : await insertDirective(pool, fx.company, employee, { status: 'status' in body && body.status === 'approved' ? 'pending' : 'approved', effective: '2027-03-01' });
    const before = await snapshot();
    const r = await patch(loginAs, id, body);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await snapshot()).toEqual(before);
  });

  it('delete a regular-pay directive: 403, nothing deleted', async () => {
    const id = await insertDirective(pool, fx.company, employee, { status: 'pending', effective: '2028-03-01' });
    const before = await snapshot();
    const r = await fx.call(directive, loginAs, { method: 'DELETE', query: { id } });
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await snapshot()).toEqual(before);
  });

  it('the target\'s own session is not refused', async () => {
    await pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE company_id = $1", [fx.company]);
    const r = await create(await fx.ownSession());
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(201);
  });
});
