/**
 * The employee routes' own guards, through the real withAuth chain and a real Postgres, for a user who belongs to two
 * companies. RLS shows that user the other company's rows, so only the company_id predicates keep them apart.
 *
 *  - POST .../employees/:id/components refuses another company's component before the insert.
 *  - PATCH .../employees/:id judges a changed tax or ID number as create does, and leaves a stored one alone.
 *  - The request log shows no amount on the two routes that name an employee next to one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import batches from '../../pages/api/payroll/batches';
import batchLines from '../../pages/api/payroll/batches/[id]/lines';
import employee from '../../pages/api/payroll/employees/[id]';
import components from '../../pages/api/payroll/employees/[id]/components';
import { apiLogger } from '@/lib/logger';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const owner = crypto.randomUUID();
const AMOUNT = 31_415.92;
let call: ReturnType<typeof routeCaller>;
let staff = '';
let mine = '';
let foreign = '';

const ids = async (table: string, companyId: string, extra = '') =>
  (await pool.query<{ id: string }>(`SELECT id FROM ${table} WHERE company_id = $1 ${extra}`, [companyId])).rows;
const assignments = async () => (await pool.query<{ component_id: string; amount: string }>(
  'SELECT component_id, amount::text AS amount FROM payroll_employee_components WHERE employee_id = $1', [staff])).rows;
const stored = async () => (await pool.query<{ tax_number: string | null; id_number: string | null; first_name: string }>(
  'SELECT tax_number, id_number, first_name FROM payroll_employees WHERE id = $1', [staff])).rows[0]!;
const assign = (componentId: unknown) => call(components as Route, 'POST', `/api/payroll/employees/${staff}/components`, staff, {
  body: { componentId, amount: AMOUNT, effectiveFrom: '2026-11-01', isRecurring: true },
});
const patch = (body: Record<string, unknown>) => call(employee as Route, 'PATCH', `/api/payroll/employees/${staff}`, staff, { body });

beforeAll(async () => {
  for (const [id, name] of [[company, 'Employee routes'], [other, 'Employee routes other']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  for (const id of [company, other]) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
  const token = await new SignJWT({ sub: owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [owner]: token }, { user: owner, company });
  staff = (await ids('payroll_employees', company))[0]!.id;
  mine = (await ids('payroll_components', company, "AND sars_source_code = '3601'"))[0]!.id;
  foreign = (await ids('payroll_components', other, "AND sars_source_code = '3601'"))[0]!.id;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id IN (SELECT id FROM payroll_batches WHERE company_id = $1)', [company]);
    await pool.query('DELETE FROM payroll_batches WHERE company_id = $1', [company]);
    await cleanPayrollCompanies(pool, [company, other]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner]);
  } finally { await pool.end(); }
});

describe('POST /api/payroll/employees/:id/components', () => {
  it("another company's component: 400 and no assignment, for a user who can see both companies", async () => {
    const before = await assignments();
    const out = await assign(foreign);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/not found in this company/i);
    expect(await assignments()).toEqual(before);
  });

  it('a component id that is not a uuid: 400, not a failed cast', async () => {
    const out = await assign('basic');
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
  });

  it("this company's component is assigned", async () => {
    const out = await assign(mine);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    expect((await assignments()).map(r => [r.component_id, r.amount])).toContainEqual([mine, String(AMOUNT)]);
  });
});

describe('PATCH /api/payroll/employees/:id', () => {
  it.each([
    ['tax number', { taxNumber: '4123456789' }, /tax number/i],
    ['tax number, not text', { taxNumber: 123 }, /tax number/i],
    ['ID number', { idNumber: '12345' }, /ID number/i],
  ])('an invalid %s: 400 and nothing changes', async (_n, body, reason) => {
    const before = await stored();
    const out = await patch({ firstName: 'Changed', ...body });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(reason);
    expect(await stored()).toEqual(before);
  });

  it('valid numbers are stored trimmed', async () => {
    const out = await patch({ taxNumber: ' 1234567890 ', idNumber: ' 8001015009087 ' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await stored()).toMatchObject({ tax_number: '1234567890', id_number: '8001015009087' });
  });

  it('a stored number the rule would refuse does not block saving the rest of the profile', async () => {
    await pool.query("UPDATE payroll_employees SET id_number = 'A12345678' WHERE id = $1", [staff]);
    const out = await patch({ firstName: 'Renamed', idNumber: 'A12345678' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await stored()).toMatchObject({ first_name: 'Renamed', id_number: 'A12345678' });
    const changed = await patch({ idNumber: 'A12345679' });
    expect(changed.statusCode, JSON.stringify(changed.body)).toBe(400);
  });

  it("another company's employee: 404", async () => {
    const theirs = (await ids('payroll_employees', other))[0]!.id;
    const out = await call(employee as Route, 'PATCH', `/api/payroll/employees/${theirs}`, theirs, { body: { taxNumber: '4123456789' } });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(404);
  });
});

describe('the request log', () => {
  const logged = (spy: { mock: { calls: unknown[][] } }) => JSON.stringify(spy.mock.calls);

  it('an assignment logs no amount beside the employee in the URL', async () => {
    const spy = vi.spyOn(apiLogger, 'info');
    expect((await assign(mine)).statusCode).toBe(201);
    expect(logged(spy)).toContain(staff);
    expect(logged(spy)).toContain('"amount":"[omitted]"');
    expect(logged(spy)).not.toContain('31415.92');
  });

  it('a batch line logs no pay figure beside its employee', async () => {
    const made = await call(batches as Route, 'POST', '/api/payroll/batches', undefined, {
      body: { batchType: 'component_values', componentId: mine, description: 'Overtime', periodYear: 2026, periodMonth: 11 },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    const spy = vi.spyOn(apiLogger, 'info');
    const out = await call(batchLines as Route, 'POST', `/api/payroll/batches/${id}/lines`, id, {
      body: { lines: [{ employeeId: staff, value: AMOUNT, effectiveFrom: '2026-11-01' }] },
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(logged(spy)).toContain(staff);
    expect(logged(spy)).toContain('"value":"[omitted]"');
    expect(logged(spy)).not.toContain('31415.92');
  });
});
