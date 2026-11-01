/**
 * The employee routes' own guards, through the real withAuth chain and a real Postgres, for a user who belongs to two
 * companies. RLS shows that user the other company's rows, so only the company_id predicates keep them apart.
 *
 *  - POST .../employees/:id/components refuses another company's component before the insert.
 *  - PATCH .../employees/:id judges a changed tax or ID number and end date as create does, and leaves stored ones alone.
 *  - GET .../employees/:id/components says when an assignment's component is switched off (a run does not pay it).
 *  - The request log shows no amount on the four routes that name an employee next to one: component assignments,
 *    batch lines, tax directives and loans.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import taxDirectives from '../../pages/api/accounting/tax-directives';
import batches from '../../pages/api/payroll/batches';
import batchLines from '../../pages/api/payroll/batches/[id]/lines';
import employee from '../../pages/api/payroll/employees/[id]';
import components from '../../pages/api/payroll/employees/[id]/components';
import loans from '../../pages/api/payroll/loans';
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

describe('GET /api/payroll/employees/:id/components', () => {
  it('says which assignments sit on a switched-off component', async () => {
    const off = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_active)
       VALUES ($1, 'Retired', '3713', 'earning', false) RETURNING id`, [company])).rows[0]!.id;
    await pool.query(
      "INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1,$2,1,'2026-01-01')", [staff, off]);
    const out = await call(components as Route, 'GET', `/api/payroll/employees/${staff}/components`, staff);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    const rows = out.body.data as unknown as Array<{ componentId: string; componentActive: boolean }>;
    expect(rows.find(r => r.componentId === off)?.componentActive).toBe(false);
    expect(rows.find(r => r.componentId === mine)?.componentActive).toBe(true);
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

  const endDate = async () => (await pool.query<{ end_date: string | null }>(
    'SELECT end_date::text AS end_date FROM payroll_employees WHERE id = $1', [staff])).rows[0]!.end_date;
  const setEndDate = (day: string | null) => pool.query('UPDATE payroll_employees SET end_date = $2 WHERE id = $1', [staff, day]);

  it.each([
    ['before the start date', '2019-12-31', /endDate cannot be before startDate/],
    ['before it, as a timestamp', '2019-12-31T00:00:00.000Z', /endDate cannot be before startDate/],
    ['not a date', 'soon', /endDate must be a real date/],
    ['not text', 20301231, /endDate must be a real date/],
    // Each of these starts with a good day. Postgres would take the second as 2030 BC.
    ['with junk after the day', '2030-01-01junk', /endDate must be a real date/],
    ['with an era after the day', '2030-01-01 BC', /endDate must be a real date/],
    ['with another time on it', '2030-01-01T12:00:00.000Z', /endDate must be a real date/],
    ['with junk after the timestamp', '2030-01-01T00:00:00.000Zjunk', /endDate must be a real date/],
  ])('an end date %s: 400 and nothing changes', async (_n, value, reason) => {
    await setEndDate(null);
    const out = await patch({ firstName: 'Changed', endDate: value });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(reason);
    expect(await endDate()).toBeNull();
    expect((await stored()).first_name).not.toBe('Changed');
  });

  it.each([
    ['on the start date', '2020-01-01'], ['after it', '2030-12-31'], ['as the timestamp the API answers with', '2030-12-31T00:00:00.000Z'],
  ])('an end date %s is stored', async (_n, value) => {
    await setEndDate(null);
    const out = await patch({ endDate: value });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await endDate()).toBe(value.slice(0, 10));
    await setEndDate(null);
  });

  const birthDate = async () => (await pool.query<{ date_of_birth: string | null }>(
    'SELECT date_of_birth::text AS date_of_birth FROM payroll_employees WHERE id = $1', [staff])).rows[0]!.date_of_birth;

  it.each([
    ['with an era after the day', '2030-01-01 BC'], ['with junk after the day', '1980-05-01junk'],
    ['with another time on it', '1980-05-01T12:00:00.000Z'], ['not a date', 'soon'], ['not text', 19800501],
  ])('a date of birth %s: 400 and it stands', async (_n, value) => {
    const before = await birthDate();
    const out = await patch({ dateOfBirth: value });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/dateOfBirth must be a real date/);
    expect(await birthDate()).toBe(before);
  });

  it.each([
    ['a plain day', '1981-02-03'], ['the timestamp the API answers with', '1982-03-04T00:00:00.000Z'],
  ])('a date of birth as %s is stored as the day', async (_n, value) => {
    const out = await patch({ dateOfBirth: value });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await birthDate()).toBe(value.slice(0, 10));
  });

  it('a start date in the body changes nothing: PATCH does not write it', async () => {
    const start = async () => (await pool.query<{ s: string }>('SELECT start_date::text AS s FROM payroll_employees WHERE id = $1', [staff])).rows[0]!.s;
    const before = await start();
    const out = await patch({ startDate: '2030-01-01 BC' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await start()).toBe(before);
  });

  it('a suffix on the stored day is not the stored day: refused, and the date stands', async () => {
    await setEndDate('2030-06-30');
    const out = await patch({ endDate: '2030-06-30 BC' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await endDate()).toBe('2030-06-30');
    await setEndDate(null);
  });

  it('a stored end date the rule would refuse does not block saving the rest, resent as the API answers it', async () => {
    await setEndDate('2019-06-30');
    const out = await patch({ firstName: 'Kept', endDate: '2019-06-30T00:00:00.000Z' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect((await stored()).first_name).toBe('Kept');
    await setEndDate(null);
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

  // A refused body is logged like any other: the log line is written before the handler runs.
  it('a tax directive logs no amount beside its employee', async () => {
    const spy = vi.spyOn(apiLogger, 'info');
    const out = await call(taxDirectives as Route, 'POST', '/api/accounting/tax-directives', undefined, {
      body: {
        employee_id: staff, directive_type: 'severance', amount: AMOUNT, tax_rate: 0.1837,
        employee_tax_number: '0123456789', notes: 'Retrenched after the Durban closure',
      },
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(logged(spy)).toContain(staff);
    expect(logged(spy)).toContain('"amount":"[omitted]"');
    expect(logged(spy)).not.toContain('31415.92');
    expect(logged(spy)).not.toContain('0.1837');
    expect(logged(spy)).not.toContain('0123456789');
    expect(logged(spy)).not.toContain('Durban');
  });

  it('a loan logs no principal beside its employee', async () => {
    const spy = vi.spyOn(apiLogger, 'info');
    const out = await call(loans as Route, 'POST', '/api/payroll/loans', undefined, { body: { employeeId: staff, principal: AMOUNT } });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(logged(spy)).toContain(staff);
    expect(logged(spy)).toContain('"principal":"[omitted]"');
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
