/**
 * PAYE 4a follow-ups round 2, R4 and R6.
 *
 * R4: a directive names the payroll employee it is paid to (employee_id): a run
 * pays a severance directive only to that employee and the stand-alone
 * payment (applyTaxDirective) refuses a directive without one, so the create
 * route requires it and refuses an id that is not one of the company's
 * employees (400, nothing written). It cannot be changed afterwards (PATCH
 * 400): the run's claim at approval does not re-read the employee, so moving
 * an approved directive to another employee would let a run calculated for
 * the first one claim it. The employee list the form's picker reads includes
 * leavers on request (?include=terminated): severance, retirement and death
 * directives are for people who have left.
 *
 * R6: the live updateTaxDirectiveStatus (payroll/taxDirectiveService) cancels
 * through updateTaxDirective and so through the paid guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import directives from '../../pages/api/accounting/tax-directives';
import directive from '../../pages/api/accounting/tax-directives/[id]';
import employeesRoute from '../../pages/api/payroll/employees';
import type { Route } from './w3-01-payroll.helpers';
import {
  applyStandalone, approvedDirective, cleanSeveranceFixtures, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';
import { TaxDirectivePaidError, updateTaxDirectiveStatus } from '@/modules/accounting/services/payroll/taxDirectiveService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let f: SeveranceFixture;
let other: SeveranceFixture;

const BODY = { employee_name: 'Wanda Test', directive_type: 'severance', amount: 10_000, tax_rate: 0.1, effective_date: '2026-05-01' };
const post = (body: Record<string, unknown>) =>
  f.call(directives as Route, 'POST', '/api/accounting/tax-directives', undefined, { body });
const countDirectives = async (company: string) =>
  Number((await pool.query('SELECT count(*) AS n FROM tax_directives WHERE company_id = $1', [company])).rows[0]!.n);

async function listEmployees(query: Record<string, string>): Promise<{ statusCode: number; ids: string[] }> {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as {
    url: string; query: Record<string, unknown>;
  };
  req.url = `/api/payroll/employees?${new URLSearchParams(query)}`;
  req.query = query;
  const out = response();
  await (employeesRoute as Route)(req as never, out.res as never);
  const data = (out.state.body as { data?: Array<{ id: string }> }).data ?? [];
  return { statusCode: out.state.statusCode, ids: data.map(e => e.id) };
}

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2026-04-30', 'R4 directive employee');
  other = await seedRetrenchedEmployee(pool, '2026-04-30', 'R4 other company');
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f, other].filter(Boolean)); } finally { await pool.end(); }
});

describe('R4: the create route requires one of the company\'s employees', () => {
  it('no employee_id: 400, nothing written', async () => {
    const before = await countDirectives(f.company);
    const r = await post(BODY);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/employee_id/);
    expect(await countDirectives(f.company)).toBe(before);
  });

  it('an employee_id that is not a UUID: 400, nothing written', async () => {
    const before = await countDirectives(f.company);
    const r = await post({ ...BODY, employee_id: 'not-a-uuid' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(await countDirectives(f.company)).toBe(before);
  });

  it('another company\'s employee: 400, nothing written in either company', async () => {
    const [mine, theirs] = [await countDirectives(f.company), await countDirectives(other.company)];
    const r = await post({ ...BODY, employee_id: other.employee });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/not an employee of this company/);
    expect([await countDirectives(f.company), await countDirectives(other.company)]).toEqual([mine, theirs]);
  });

  it('a random UUID that is nobody\'s employee: 400', async () => {
    const r = await post({ ...BODY, employee_id: crypto.randomUUID() });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
  });

  it('the company\'s own (terminated) employee: 201, and the row names that employee', async () => {
    const r = await post({ ...BODY, employee_id: f.employee });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    const row = (await pool.query('SELECT employee_id, company_id FROM tax_directives WHERE id = $1', [r.body.data!.id])).rows[0]!;
    expect(row).toEqual({ employee_id: f.employee, company_id: f.company });
  });
});

describe('R4: the employee cannot be changed afterwards', () => {
  it('PATCH employee_id: 400, the row keeps its employee', async () => {
    const made = await post({ ...BODY, employee_id: f.employee });
    const id = String(made.body.data!.id);
    const second = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
       VALUES ($1, 'R4-2', 'Second', 'Person', '2021-01-01') RETURNING id`, [f.company])).rows[0]!.id;
    for (const body of [{ employee_id: second }, { status: 'approved', employee_id: second }]) {
      const r = await f.call(directive as Route, 'PATCH', `/api/accounting/tax-directives/${id}`, id, { body });
      expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error?.message).toMatch(/employee/);
    }
    const row = (await pool.query('SELECT employee_id, status FROM tax_directives WHERE id = $1', [id])).rows[0]!;
    expect(row).toEqual({ employee_id: f.employee, status: 'pending' });
  });
});

describe('R4: the picker\'s employee list', () => {
  it('lists leavers only on request; the default list stays active-only', async () => {
    const active = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
       VALUES ($1, 'R4-A', 'Still', 'Here', '2021-01-01') RETURNING id`, [f.company])).rows[0]!.id;
    const inactive = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status)
       VALUES ($1, 'R4-I', 'Not', 'Paid', '2021-01-01', 'inactive') RETURNING id`, [f.company])).rows[0]!.id;
    const plain = await listEmployees({});
    expect(plain.statusCode).toBe(200);
    expect(plain.ids).toContain(active);
    expect(plain.ids).not.toContain(f.employee);
    const withLeavers = await listEmployees({ include: 'terminated' });
    expect(withLeavers.statusCode).toBe(200);
    expect(withLeavers.ids).toEqual(expect.arrayContaining([active, f.employee]));
    expect(withLeavers.ids).not.toContain(inactive);
    expect(withLeavers.ids).not.toContain(other.employee);
  });
});

describe('R6: the live updateTaxDirectiveStatus cancels through the paid guard', () => {
  it('a paid directive cannot be cancelled through it; an unpaid one can', async () => {
    const paid = await approvedDirective(f, 8_000, 0.2, '2026-05-01', '7777777777');
    expect((await applyStandalone(f, paid, '2026-05-20')).statusCode).toBe(200);
    await expect(updateTaxDirectiveStatus(f.company, paid, 'cancelled', f.admin)).rejects.toBeInstanceOf(TaxDirectivePaidError);
    expect((await pool.query('SELECT status FROM tax_directives WHERE id = $1', [paid])).rows[0]!.status).toBe('approved');

    const unpaid = await approvedDirective(f, 8_000, 0.2, '2026-05-01', '7777777778');
    expect((await updateTaxDirectiveStatus(f.company, unpaid, 'cancelled', f.admin))?.status).toBe('cancelled');
  });
});
