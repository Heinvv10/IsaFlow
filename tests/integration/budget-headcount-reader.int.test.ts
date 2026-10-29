/**
 * Budgets P4 headcount (decision 7, spec §9 `budget-headcount-reader`): the payroll reader and the
 * per-month headcount on a fixture with start / end boundary days, an inactive and a terminated
 * employee, a cost-centre split and a planned hire; the reader's and the headcount answer's keys
 * hold no personal field; company A's reader never sees company B's employees, even for a user who
 * belongs to both (payroll's RLS admits every company the user belongs to), on an owner connection
 * and as app_user. Real PostgreSQL.
 *
 * FY2027 = March 2026 - February 2027. Expected counts are worked by hand in the comments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture, type Co } from './helpers/budgetVersionFixture';
import { readPayrollHeadcount } from '@/modules/accounting/services/budgets/drivers/payrollHeadcountReader';
import { readHeadcount } from '@/modules/accounting/services/budgets/drivers/plannedHireService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, B, setup, cleanup, version, asAppUser } = budgetVersionFixture(pool);
const PII = /name|id_?number|tax|salary|wage|bank|email|phone|address|birth|gender|race|medical/i;
let v: string;
const ids: Record<string, string> = {};

async function employee(c: Co, key: string, o: { start: string; end?: string | null; status?: string; cc?: string | null }) {
  ids[key] = String((await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, id_number, tax_number, start_date, end_date, status, cost_centre_id)
     VALUES ($1, $2, 'Zanele', $3, '8001015009087', '0123456789', $4, $5, $6, $7) RETURNING id`,
    [c.id, `HC-${key}`, `Secret-${key}`, o.start, o.end ?? null, o.status ?? 'active', o.cc ?? null])).rows[0].id);
}

beforeAll(async () => {
  await setup();
  // e1: starts on the LAST day of March: one head from March (any day employed counts).
  await employee(A, 'e1', { start: '2026-03-31', cc: A.cc1 });
  // e2: ends on the FIRST day of April: a head in March and April, not May.
  await employee(A, 'e2', { start: '2025-06-01', end: '2026-04-01', cc: A.cc1 });
  // e3: inactive: never a head.
  await employee(A, 'e3', { start: '2025-01-01', status: 'inactive', cc: A.cc1 });
  // e4: starts 1 May, terminated 30 June: May and June.
  await employee(A, 'e4', { start: '2026-05-01', end: '2026-06-30', status: 'terminated' });
  // e5: own centre CC2, but split 60% Cape Town / 40% Durban: the split wins.
  await employee(A, 'e5', { start: '2026-03-01', cc: A.cc2 });
  // e6: ends before it starts (payroll has no CHECK for it): no day employed, never a head, and no 500.
  await employee(A, 'e6', { start: '2026-05-20', end: '2026-05-01', cc: A.cc1 });
  await pool.query(
    `INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage)
     VALUES ($1, $2, $3, 60), ($1, $2, $4, 40)`, [A.id, ids.e5, A.cc1, A.cc1b]);
  // Company B: three employees active all year in its own Cape Town, one with a split.
  for (const k of ['b1', 'b2', 'b3']) await employee(B, k, { start: '2025-01-01', cc: B.cc1 });
  await pool.query(
    `INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage) VALUES ($1, $2, $3, 100)`,
    [B.id, ids.b1, B.cc1]);
  v = await version(A);
  // A planned hire in Cape Town from June, half time.
  await pool.query(
    `INSERT INTO budget_planned_hires (company_id, version_id, label, cost_centre_id, start_month, fte, created_by)
     VALUES ($1, $2, 'Sales rep', $3, '2026-06-01', 0.5, $4)`, [A.id, v, A.cc1, A.user]);
  // A's member also belongs to B: payroll's RLS then admits B's rows to A's sessions.
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [B.id, A.user]);
}, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [B.id, A.user]);
    await pool.query('DELETE FROM payroll_employee_cost_allocations WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [[A.id, B.id]]);
    await cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

/** The service as withAuth runs it: app_user, A's member's claims, A active. */
const asA = <T>(fn: () => Promise<T>) =>
  asAppUser(A, (client) => als.run({ client, userId: A.user, companyId: A.id, claims: { sub: A.user } } as never, fn));

const keysOf = (xs: object[]) => [...new Set(xs.flatMap((x) => Object.keys(x)))].sort();

describe('payroll headcount reader', () => {
  it("reads only company A's employees and allocations, on an owner connection and as app_user (an end before the start left out)", async () => {
    const own = [ids.e1, ids.e2, ids.e3, ids.e4, ids.e5].sort();
    for (const read of [() => readPayrollHeadcount(A.id), () => asA(() => readPayrollHeadcount(A.id))]) {
      const got = await read();
      expect(got.employees.map((e) => e.id).sort()).toEqual(own);
      expect(got.allocations.map((a) => a.employeeId)).toEqual([ids.e5, ids.e5]);
    }
    // The RLS policy alone would have let B's rows through to A's session.
    const visible = await asAppUser(A, async (q) => (await q.query('SELECT count(*)::int AS n FROM payroll_employees WHERE company_id = $1', [B.id])).rows[0].n);
    expect(visible).toBe(3);
  });

  it('answers ids, dates, status and centres only: no personal field and no name', async () => {
    const got = await readPayrollHeadcount(A.id);
    expect(keysOf(got.employees)).toEqual(['costCentreId', 'endDate', 'id', 'startDate', 'status']);
    expect(keysOf(got.allocations)).toEqual(['costCentreId', 'employeeId', 'percentage']);
    expect(JSON.stringify(got)).not.toMatch(/Zanele|Secret|8001015009087|0123456789/);
    const e2 = got.employees.find((e) => e.id === ids.e2)!;
    expect(e2).toEqual({ id: ids.e2, startDate: '2025-06-01', endDate: '2026-04-01', status: 'active', costCentreId: A.cc1 });
  });
});

describe('version headcount (counts only)', () => {
  it('company scope: boundary days count a full head, inactive never, terminated until its end date', async () => {
    const hc = await asA(() => readHeadcount(A.id, v, null));
    const at = (m: string) => hc.months.find((x) => x.month === m)!;
    expect(hc.months.map((x) => x.month)).toHaveLength(12);
    // March: e1 (starts 31st) + e2 + e5 = 3. April: e1 + e2 (ends 1st) + e5 = 3. May: e1 + e4 + e5 = 3.
    expect(at('2026-03')).toEqual({ month: '2026-03', payroll: 3, hires: 0, total: 3 });
    expect(at('2026-04')).toEqual({ month: '2026-04', payroll: 3, hires: 0, total: 3 });
    expect(at('2026-05')).toEqual({ month: '2026-05', payroll: 3, hires: 0, total: 3 });
    // June: e1 + e4 (until the 30th) + e5 = 3, + the hire 0.5. July: e1 + e5 = 2 + 0.5.
    expect(at('2026-06')).toEqual({ month: '2026-06', payroll: 3, hires: 0.5, total: 3.5 });
    expect(at('2026-07')).toEqual({ month: '2026-07', payroll: 2, hires: 0.5, total: 2.5 });
    expect(Object.keys(hc).sort()).toEqual(['asOf', 'costCentreId', 'months']);
    expect(keysOf(hc.months)).toEqual(['hires', 'month', 'payroll', 'total']);
    expect(Number.isNaN(Date.parse(hc.asOf))).toBe(false);
    expect(JSON.stringify(hc)).not.toMatch(PII);
  });

  it('cost-centre scope: the allocation split replaces the own centre; no B employee counts', async () => {
    // Cape Town, March: e1 1 + e2 1 + e5 0.6 = 2.6; June: e1 1 + e5 0.6 + hire 0.5 = 2.1.
    const ct = await asA(() => readHeadcount(A.id, v, A.cc1));
    expect(ct.months.find((x) => x.month === '2026-03')).toEqual({ month: '2026-03', payroll: 2.6, hires: 0, total: 2.6 });
    expect(ct.months.find((x) => x.month === '2026-06')).toEqual({ month: '2026-06', payroll: 1.6, hires: 0.5, total: 2.1 });
    // Durban: e5's 40% only.
    const dbn = await asA(() => readHeadcount(A.id, v, A.cc1b));
    expect(dbn.months.find((x) => x.month === '2026-03')!.total).toBe(0.4);
    // CC2: e5's own centre, overridden by its split: nobody.
    const retail = await asA(() => readHeadcount(A.id, v, A.cc2));
    expect(new Set(retail.months.map((x) => x.total))).toEqual(new Set([0]));
  });

  it("another company's cost centre is refused, and another company's version is not found", async () => {
    await expect(asA(() => readHeadcount(A.id, v, B.cc1))).rejects.toMatchObject({ code: 'BUDGET_VERSION_INPUT' });
    const theirs = await version(B);
    await expect(asA(() => readHeadcount(A.id, theirs, null))).rejects.toMatchObject({ code: 'BUDGET_VERSION_NOT_FOUND' });
  });
});
