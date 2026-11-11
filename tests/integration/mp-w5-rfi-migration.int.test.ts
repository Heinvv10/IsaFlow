/**
 * Wave 5 RF: migration 975 (counts_as_rfi, percent_of_rfi). Real Postgres (disposable fixture only). The migration file is
 * run, twice, INSIDE a transaction that is rolled back, so its backfill touches no row another suite can see afterwards.
 * Backfill: every EARNING coded 3601 (after the trim) counts as RFI; nothing else does; a re-run changes nothing.
 * CHECKs: counts_as_rfi only on an earning; percent_of_rfi above 0, at most 1, and only with amount 0.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const mig = readFileSync(`${__dirname}/../../scripts/migrations/sql/975_payroll_rfi.sql`, 'utf8');
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const ids: Record<string, string> = {};
let afterOnce: Record<string, boolean> = {};
let afterTwice: Record<string, boolean> = {};
let asCash: Record<string, boolean> = {};

async function component(key: string, code: string, type: string, owner = company): Promise<void> {
  ids[key] = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable, counts_as_rfi)
     VALUES ($1, $2, $3, $4, true, false) RETURNING id`, [owner, `RF ${key}`, code, type])).rows[0]!.id;
}
async function assignment(key: string, comp: string, pct: number | null): Promise<void> {
  ids[key] = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, percent_of_rfi)
     VALUES ($1, $2, $3, '2025-03-01', $4) RETURNING id`, [ids.emp, ids[comp], pct == null ? 1500 : 0, pct])).rows[0]!.id;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'RF migration']);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'RF migration other']);
  await component('salary', '3601', 'earning');
  await component('padded', ' 3601 ', 'earning');
  await component('commission', '3606', 'earning');
  await component('deduction3601', '3601', 'deduction');
  await component('pension', '4001', 'deduction');
  await component('erPension', ' 3817 ', 'earning');
  await component('erRa', '3828', 'earning');
  await component('erDeduction', '3825', 'deduction');
  await component('foreignEr', '3817', 'earning', other);
  ids.emp = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1, 'RF-0', 'R', 'F', '2020-01-01') RETURNING id`,
    [company])).rows[0]!.id;
  // Assignments that exist when 975 runs (the column default is FALSE, as before the backfill).
  await assignment('aPension', 'erPension', null);
  await assignment('aRa', 'erRa', null);
  await assignment('aPercent', 'erPension', 0.15);
  await assignment('aDeduction', 'erDeduction', null);
  await assignment('aForeign', 'foreignEr', null);
  await assignment('aSalary', 'salary', null);
  const read = async (client: { query: Pool['query'] }) => Object.fromEntries((await client.query<{ name: string; c: boolean }>(
    'SELECT name, counts_as_rfi AS c FROM payroll_components WHERE company_id = $1', [company])).rows.map((r) => [r.name.slice(3), r.c]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(mig);
    afterOnce = await read(client as never);
    await client.query(mig);
    afterTwice = await read(client as never);
    asCash = Object.fromEntries((await client.query<{ id: string; c: boolean }>(
      'SELECT id, employer_fund_as_cash AS c FROM payroll_employee_components WHERE employee_id = $1', [ids.emp])).rows
      .map((r) => [Object.keys(ids).find((k) => ids[k] === r.id)!, r.c]));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company, other]);
  } finally { await pool.end(); }
});

describe('migration 975 backfill', () => {
  it('flags every earning coded 3601, read after the trim, and nothing else', () => {
    expect(afterOnce).toEqual({ salary: true, padded: true, commission: false, deduction3601: false, pension: false, erPension: false, erRa: false, erDeduction: false });
  });
  it('a re-run changes nothing', () => {
    expect(afterTwice).toEqual(afterOnce);
  });
  it('left nothing behind (rolled back)', async () => {
    const n = (await pool.query<{ n: string }>('SELECT count(*) AS n FROM payroll_components WHERE company_id = $1 AND counts_as_rfi', [company])).rows[0]!.n;
    expect(n).toBe('0');
  });
});

describe('migration 975 opt-out backfill: existing employer fund assignments keep the cash treatment (no figure change)', () => {
  it('marks a fixed-amount 3817 / 3828 earning of the employee\'s own company, read after the trim; nothing else', () => {
    expect(asCash).toEqual({ aPension: true, aRa: true, aPercent: false, aDeduction: false, aForeign: false, aSalary: false });
  });
});

describe('migration 975 constraints', () => {
  const code = async (text: string, values: unknown[]) => {
    try { await pool.query(text, values); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'err'; }
  };
  it('counts_as_rfi is refused on a deduction', async () => {
    expect(await code('UPDATE payroll_components SET counts_as_rfi = true WHERE id = $1', [ids.pension])).toBe('23514');
  });
  it('percent_of_rfi: above 0, at most 1, and only with amount 0', async () => {
    const emp = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1, 'RF-1', 'R', 'F', '2020-01-01') RETURNING id`,
      [company])).rows[0]!.id;
    const insert = (amount: number, pct: number) => code(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, percent_of_rfi) VALUES ($1, $2, $3, '2026-03-01', $4)`,
      [emp, ids.pension, amount, pct]);
    expect(await insert(0, 1.5)).toBe('23514');
    expect(await insert(0, 0)).toBe('23514');
    expect(await insert(100, 0.075)).toBe('23514');
    expect(await insert(0, 0.075)).toBe('ok');
    expect(await insert(0, 1)).toBe('ok');
  });
});
