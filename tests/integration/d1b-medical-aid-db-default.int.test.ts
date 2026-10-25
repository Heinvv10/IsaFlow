/**
 * D1b — payroll_employees.medical_aid_main_member defaults to FALSE in the
 * database (migration 933). Migration 380 declared DEFAULT TRUE, so any insert
 * that left the column out (a script, a future code path, a manual row) made a
 * medical-aid main member and with it a monthly PAYE medical tax credit. An
 * explicit value is untouched either way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = crypto.randomUUID();

const insert = async (number: string, column = '', value = '') => (await pool.query<{ m: boolean }>(
  `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date${column})
   VALUES ($1, $2, 'D1b', $2, '2020-01-01'${value}) RETURNING medical_aid_main_member AS m`, [company, number])).rows[0]!.m;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'D1b medical-aid default']);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
  } finally { await pool.end(); }
});

describe('payroll_employees.medical_aid_main_member', () => {
  it('an insert that leaves the column out stores false', async () => {
    expect(await insert('D1B-DEFAULT')).toBe(false);
  });

  it('the catalogue default is false', async () => {
    const { rows } = await pool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payroll_employees' AND column_name = 'medical_aid_main_member'`);
    expect(rows[0]!.column_default).toBe('false');
  });

  it('an explicit true is still stored as true, and an explicit false as false', async () => {
    expect(await insert('D1B-TRUE', ', medical_aid_main_member', ', true')).toBe(true);
    expect(await insert('D1B-FALSE', ', medical_aid_main_member', ', false')).toBe(false);
  });
});
