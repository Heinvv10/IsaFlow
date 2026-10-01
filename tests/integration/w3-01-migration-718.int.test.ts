/**
 * W3-01 round 7 — migration 718 creates the columns approval writes.
 *
 * approvePayrollRun writes payroll_run_headers.approved_by / approved_at (and, from
 * round 7, lines_confirmed_at). The first two existed only on databases cloned from
 * dev — no migration created them — so a database built from the migrations alone
 * failed every approve. Pinned here:
 *   · on a table without them, the migration adds all three, with dev's types and no FK;
 *   · run again (as on dev, where two already exist) it changes nothing;
 *   · approve writes them, reopen clears the approval and keeps the marker.
 * The DDL runs inside a transaction that is rolled back. Disposable fixture DB only.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const MIGRATION = readFileSync(path.join(__dirname, '../../scripts/migrations/sql/718_payroll_run_approved_marker.sql'), 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company });

const columns = async (db: { query: Pool['query'] }) => (await db.query(
  `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_name = 'payroll_run_headers' AND column_name IN ('approved_by', 'approved_at', 'lines_confirmed_at')
    ORDER BY column_name`)).rows;
const foreignKeys = async (db: { query: Pool['query'] }) => (await db.query(
  `SELECT conname FROM pg_constraint WHERE conrelid = 'payroll_run_headers'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) ~ '(approved_by|approved_at|lines_confirmed_at)'`)).rows;
const EXPECTED = [
  { column_name: 'approved_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
  { column_name: 'approved_by', data_type: 'uuid', is_nullable: 'YES', column_default: null },
  { column_name: 'lines_confirmed_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
];

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'W301 migration 718']);
  await seedPayrollCompany(pool, company);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  tokens[admin] = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
  } finally { await pool.end(); }
});

describe('migration 718 (W3-01 round 7)', () => {
  it('adds the three columns to a table that lacks them, and is a no-op run again', async () => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE payroll_run_headers DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS lines_confirmed_at');
      expect(await columns(db)).toEqual([]);
      await db.query(MIGRATION);
      expect(await columns(db)).toEqual(EXPECTED);
      expect(await foreignKeys(db)).toEqual([]);
      await db.query(MIGRATION); // as on a database that already has them
      expect(await columns(db)).toEqual(EXPECTED);
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });

  it('approve writes them; reopen clears the approval and keeps the lines marker', async () => {
    const id = await calculatedRun(call, 1);
    const url = (a: string) => `/api/payroll/runs/${id}/${a}`;
    const hash = (await call(journalPlan as Route, 'GET', url('journal-plan'), id)).body.data!.planHash;
    expect((await call(approve as Route, 'POST', url('approve'), id, { body: { expectedPlanHash: hash } })).statusCode).toBe(200);
    const read = async () => (await pool.query(
      'SELECT approved_by, approved_at IS NOT NULL AS approved, lines_confirmed_at FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
    const approved = await read();
    expect(approved).toMatchObject({ approved_by: admin, approved: true });
    expect(approved.lines_confirmed_at).not.toBeNull();

    expect((await call(reopen as Route, 'POST', url('reopen'), id, { body: { reason: 'w301 migration 718' } })).statusCode).toBe(200);
    expect(await read()).toEqual({ approved_by: null, approved: false, lines_confirmed_at: approved.lines_confirmed_at });
  });
});
