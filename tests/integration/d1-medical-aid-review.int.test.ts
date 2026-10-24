/**
 * D1 — medical-aid main-member defaults and the read-only review.
 *
 * A main member earns a monthly medical tax credit in PAYE, and the flag used
 * to default to true, so employees captured without medical aid were
 * under-deducted. This pins, against real Postgres through the real withAuth
 * chain and real handlers:
 *   - POST /api/payroll/employees with no answer stores false; only true stores true;
 *   - PATCH without the field leaves the stored value alone;
 *   - GET /api/payroll/employees/medical-aid-review returns exactly the active
 *     main members with no medical-aid deduction in force today, for the
 *     caller's company only, and refuses a viewer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import employeesIndex from '../../pages/api/payroll/employees';
import employeeDetail from '../../pages/api/payroll/employees/[id]';
import review from '../../pages/api/payroll/employees/medical-aid-review';
import { listMainMembersWithoutMedicalDeduction } from '../../src/modules/accounting/services/payroll/payrollMedicalAidReviewService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const ownerA = crypto.randomUUID();
const viewerA = crypto.randomUUID();
const ownerB = crypto.randomUUID();
const tokens: Record<string, string> = {};
const callA = routeCaller(tokens, { user: ownerA, company: companyA });
const callB = routeCaller(tokens, { user: ownerB, company: companyB });
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function employee(company: string, number: string, over: { main?: boolean; status?: string } = {}): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, medical_aid_main_member, status)
     VALUES ($1, $2, 'Emp', $2, '2020-01-01', $3, $4) RETURNING id`,
    [company, number, over.main ?? true, over.status ?? 'active'])).rows[0]!.id;
}
async function component(company: string, name: string, code: string, type: string, active = true): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [company, name, code, type, active])).rows[0]!.id;
}
async function assign(emp: string, comp: string, from: string, to: string | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
     VALUES ($1, $2, 1000, $3, $4)`, [emp, comp, from, to]);
}

const flagged = async (call: typeof callA, user?: string) => {
  const r = await call(review as Route, 'GET', '/api/payroll/employees/medical-aid-review', undefined, user ? { user } : {});
  return r;
};
const numbers = (r: Awaited<ReturnType<typeof flagged>>) =>
  ((r.body.data as unknown as { employees: Array<{ employeeNumber: string }> }).employees).map((e) => e.employeeNumber).sort();

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'D1 company A'], [companyB, 'D1 company B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  for (const [u, company, role] of [[ownerA, companyA, 'owner'], [viewerA, companyA, 'viewer'], [ownerB, companyB, 'owner']] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    tokens[u] = await sign(u);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, u, role]);
  }

  const medA = await component(companyA, 'Medical Aid', '4005', 'deduction');
  const namedA = await component(companyA, 'Discovery Medical Scheme', '4001', 'deduction');   // medical by name, not by code
  const inactiveMedA = await component(companyA, 'Old Medical Aid', '4005', 'deduction', false);
  const medEarningA = await component(companyA, 'Medical Reimbursement', '4005', 'earning');
  const salaryA = await component(companyA, 'Basic Salary', '3601', 'earning');

  await employee(companyA, 'A01');                                             // flagged: nothing assigned
  await assign(await employee(companyA, 'A02'), medA, '2020-01-01');           // has 4005 in force
  await assign(await employee(companyA, 'A03'), medA, day(-90), day(-30));     // flagged: 4005 ended
  await employee(companyA, 'A04', { main: false });                            // not a main member
  await assign(await employee(companyA, 'A05'), salaryA, '2020-01-01');        // flagged: only an earning
  await employee(companyA, 'A06', { status: 'terminated' });                   // terminated: out of scope
  await assign(await employee(companyA, 'A07'), namedA, '2020-01-01');         // flagged: only the 4005 code counts, not a name
  await assign(await employee(companyA, 'A08'), inactiveMedA, '2020-01-01');   // flagged: component inactive
  await assign(await employee(companyA, 'A09'), medEarningA, '2020-01-01');    // flagged: an earning is not a deduction
  await assign(await employee(companyA, 'A10'), medA, day(30));                // flagged: starts in the future
  await assign(await employee(companyA, 'A11'), medA, day(-30), day(30));      // has 4005 in force (ends later)

  // Company B: one main member with nothing, and one carrying COMPANY A's medical component.
  await employee(companyB, 'B01');
  await assign(await employee(companyB, 'B02'), medA, '2020-01-01');
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [companyA, companyB]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[ownerA, viewerA, ownerB]]);
  } finally { await pool.end(); }
});

describe('GET /api/payroll/employees/medical-aid-review', () => {
  it('company A: exactly the flagged employees', async () => {
    const r = await flagged(callA);
    expect(r.statusCode).toBe(200);
    expect(numbers(r)).toEqual(['A01', 'A03', 'A05', 'A07', 'A08', 'A09', 'A10']);
    expect((r.body.data as unknown as { count: number }).count).toBe(7);
  });

  it('company B sees only its own: B01, and B02 whose only medical component belongs to company A', async () => {
    const r = await flagged(callB);
    expect(r.statusCode).toBe(200);
    expect(numbers(r)).toEqual(['B01', 'B02']);
  });

  it('a viewer is refused', async () => {
    const r = await flagged(callA, viewerA);
    expect(r.statusCode).toBe(403);
    expect(JSON.stringify(r.body)).not.toMatch(/A01/);
  });

  it('writes nothing: every employee keeps its flag', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM payroll_employees WHERE company_id = $1 AND medical_aid_main_member', [companyA])).rows[0].n;
    await flagged(callA);
    const after = (await pool.query('SELECT count(*)::int AS n FROM payroll_employees WHERE company_id = $1 AND medical_aid_main_member', [companyA])).rows[0].n;
    expect(after).toBe(before);
  });
});

describe('the service on its own (outside a request: no row-level security to lean on)', () => {
  it("scopes by company_id itself: A's rows for A, B's for B, B02's foreign component not counted", async () => {
    const a = (await listMainMembersWithoutMedicalDeduction(companyA)).map((e) => e.employeeNumber).sort();
    const b = (await listMainMembersWithoutMedicalDeduction(companyB)).map((e) => e.employeeNumber).sort();
    expect(a).toEqual(['A01', 'A03', 'A05', 'A07', 'A08', 'A09', 'A10']);
    expect(b).toEqual(['B01', 'B02']);
  });
});

describe('creating and updating an employee', () => {
  const body = (n: string, extra: Record<string, unknown> = {}) => ({
    firstName: 'New', lastName: n, employeeNumber: n, employmentType: 'permanent', startDate: '2026-01-01', ...extra,
  });
  const stored = async (n: string) => (await pool.query<{ m: boolean }>(
    'SELECT medical_aid_main_member AS m FROM payroll_employees WHERE company_id = $1 AND employee_number = $2', [companyA, n])).rows[0]!.m;

  it('no answer → not a main member', async () => {
    const r = await callA(employeesIndex as Route, 'POST', '/api/payroll/employees', undefined, { body: body('N-DEFAULT') });
    expect(r.statusCode).toBe(201);
    expect(await stored('N-DEFAULT')).toBe(false);
  });

  it('explicit true → main member', async () => {
    const r = await callA(employeesIndex as Route, 'POST', '/api/payroll/employees', undefined, { body: body('N-TRUE', { medicalAidMainMember: true }) });
    expect(r.statusCode).toBe(201);
    expect(await stored('N-TRUE')).toBe(true);
  });

  it('an update without the field leaves the stored value alone, both ways', async () => {
    const trueId = (await pool.query<{ id: string }>("SELECT id FROM payroll_employees WHERE company_id = $1 AND employee_number = 'N-TRUE'", [companyA])).rows[0]!.id;
    const falseId = (await pool.query<{ id: string }>("SELECT id FROM payroll_employees WHERE company_id = $1 AND employee_number = 'N-DEFAULT'", [companyA])).rows[0]!.id;
    for (const id of [trueId, falseId]) {
      const r = await callA(employeeDetail as Route, 'PATCH', `/api/payroll/employees/${id}`, id, { body: { firstName: 'Renamed' } });
      expect(r.statusCode).toBe(200);
    }
    expect(await stored('N-TRUE')).toBe(true);
    expect(await stored('N-DEFAULT')).toBe(false);
  });
});
