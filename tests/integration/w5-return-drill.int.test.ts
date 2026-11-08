/**
 * Wave 5 L3s: the return drill-downs against real PostgreSQL.
 *  - EMP201: only approved and paid runs of THIS company are drilled; a calculated
 *    run, a reopened run (status calculated again, reopened_at set), a draft and a
 *    cancelled run are not; company B's runs and employees never appear and company
 *    B's run id is null for company A.
 *  - VAT201 fields 2 / 2A / 3: the revenue lines tie to getNilRatedSupplies, and
 *    another company's lines, cancelled documents and draft journals are out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { emp201FieldDrill } from '@/modules/accounting/services/reports/emp201FieldDrill';
import { listNilRatedLines } from '@/modules/accounting/services/reports/vat201NilRatedDrill';
import { getNilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const user = crypto.randomUUID();
const runs: Record<string, string> = {};
const FROM = '2026-01-01';
const TO = '2026-12-31';

async function employee(company: string, number: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
     VALUES ($1, $2, 'Emp', $2, '2020-01-01') RETURNING id`, [company, number])).rows[0]!.id;
}

async function run(company: string, key: string, month: number, status: string, paye: number, emp: string, reopened = false) {
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_paye, total_gross, total_uif, total_sdl, total_eti, employee_count, reopened_at)
     VALUES ($1, 2026, $2, $3, $4::numeric, $4::numeric * 10, 0, 0, 0, 1, $5) RETURNING id`,
    [company, month, status, paye, reopened ? new Date() : null])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, net_pay) VALUES ($1, $2, $3::numeric, $3::numeric, $4::numeric, $3::numeric)`,
    [id, emp, paye * 10, paye]);
  runs[key] = id;
}

async function account(company: string, code: string, type: string, subtype: string | null): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
     VALUES ($1, $2, $2, $3, $4, 'credit') RETURNING id`, [company, code, type, subtype])).rows[0]!.id;
}

async function revenueLine(company: string, acct: string, num: string, status: string, credit: number, vat: string) {
  const je = (await pool.query<{ id: string }>(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1, $2, '2026-06-10', 'w5 drill', $3, 'manual', $4) RETURNING id`, [company, num, status, user])).rows[0]!.id;
  await pool.query(
    `INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, vat_type) VALUES ($1, $2, $3, 0, $4, $5)`,
    [je, company, acct, credit, vat]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES ($1,$2), ($3,$4)', [A, 'W5 drill A', B, 'W5 drill B']);
  const ea = await employee(A, 'A1');
  const eb = await employee(B, 'B1');
  await run(A, 'approved', 1, 'approved', 100, ea);
  await run(A, 'paid', 2, 'paid', 200, ea);
  await run(A, 'calculated', 3, 'calculated', 400, ea);
  await run(A, 'reopened', 4, 'calculated', 800, ea, true);
  await run(A, 'draft', 5, 'draft', 1600, ea);
  await run(A, 'cancelled', 6, 'cancelled', 3200, ea);
  await run(B, 'b-approved', 1, 'approved', 6400, eb);

  const revA = await account(A, 'W5-4000', 'revenue', 'sales');
  const revB = await account(B, 'W5-4000', 'revenue', 'sales');
  await revenueLine(A, revA, 'W5-ZR', 'posted', 300, 'zero_rated');
  await revenueLine(A, revA, 'W5-EX', 'posted', 150, 'export');
  await revenueLine(A, revA, 'W5-EM', 'posted', 70, 'exempt');
  await revenueLine(A, revA, 'W5-DRAFT', 'draft', 9999, 'zero_rated');
  await revenueLine(B, revB, 'W5-B-ZR', 'posted', 5555, 'zero_rated');
});

afterAll(async () => { await pool.end(); });

describe('EMP201 drill: which runs, whose rows', () => {
  it('drills only the approved and paid runs of the company', async () => {
    const r = await emp201FieldDrill(A, FROM, TO, 'paye');
    expect(r!.runs.map((x) => x.runId).sort()).toEqual([runs.approved, runs.paid].sort());
    expect(r).toMatchObject({ total: 300, rowsTotal: 300, ties: true, rowCount: 2 });
  });

  it('a calculated, a reopened, a draft and a cancelled run each 404 by id', async () => {
    for (const k of ['calculated', 'reopened', 'draft', 'cancelled']) {
      expect(await emp201FieldDrill(A, FROM, TO, 'paye', { runId: runs[k]! }), k).toBeNull();
    }
  });

  it('company B sees only its own run; company A cannot reach it by id', async () => {
    expect(await emp201FieldDrill(B, FROM, TO, 'paye')).toMatchObject({ total: 6400, rowCount: 1 });
    expect(await emp201FieldDrill(A, FROM, TO, 'paye', { runId: runs['b-approved']! })).toBeNull();
    const a = await emp201FieldDrill(A, FROM, TO, 'paye');
    expect(a!.rows.every((x) => x.employeeNumber === 'A1')).toBe(true);
  });

  it('respects the period window', async () => {
    expect(await emp201FieldDrill(A, '2026-02-01', '2026-02-28', 'paye')).toMatchObject({ total: 200, rowCount: 1 });
  });
});

describe('VAT201 fields 2 / 2A / 3: the revenue lines tie to the aggregate', () => {
  it('lists this company\'s posted lines only and each field sums to the aggregate', async () => {
    const nil = await getNilRatedSupplies(A, FROM, TO);
    expect(nil).toMatchObject({ zeroRated: 450, exported: 150, exempt: 70 });
    const sum = async (f: '2' | '2A' | '3') => (await listNilRatedLines(A, FROM, TO, f)).reduce((s, r) => s + r.amount, 0);
    expect(await sum('2')).toBe(300);
    expect(await sum('2A')).toBe(150);
    expect(await sum('3')).toBe(70);
    expect((await listNilRatedLines(A, FROM, TO, '2')).map((r) => r.entryNumber)).toEqual(['W5-ZR']);
    expect((await listNilRatedLines(B, FROM, TO, '2')).map((r) => r.entryNumber)).toEqual(['W5-B-ZR']);
  });
});
