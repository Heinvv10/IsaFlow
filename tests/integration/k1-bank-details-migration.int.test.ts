/**
 * Wave 3 K1, migration 952 itself. The fixture's table is empty when the gate applies it, so the backfill and the
 * deduplication are proved here by replay, in a transaction that is rolled back: the table is put back to what 380
 * left, given legacy rows, and the file is run as production's deploy runs it (`postgres`, NOT a superuser, BYPASSRLS).
 * Also: the seed's DELETE of payroll_bank_details under forced RLS with no DELETE grant for any request role.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { as, asApp, cleanupEntityChanges, members, newCompany, outcome } from './entity-changes.helpers';
import { employee, ROW, rowsOf, put } from './k1-employee-bank-details.helpers';

assertDisposable();
const SQL = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/952_payroll_bank_details_tenant_history.sql'), 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', A = '', B = '';

beforeAll(async () => {
  [o] = await members(pool, tokens, 1);
  A = await newCompany(pool, [[o, 'owner']], companies);
  B = await newCompany(pool, [[o, 'owner']], companies);
});
afterAll(() => cleanupEntityChanges(pool, companies, [o]));

/** payroll_bank_details as 380 left it (the column drops also take 952's FK and indexes on them). */
const UNDO_952 = `
  DROP TRIGGER entity_change_capture ON payroll_bank_details;
  DROP POLICY payroll_detail_tenant ON payroll_bank_details;
  DROP INDEX uq_payroll_bank_details_one_active;
  ALTER TABLE payroll_bank_details DROP COLUMN company_id, DROP COLUMN account_holder;
  ALTER TABLE payroll_bank_details NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE payroll_bank_details DISABLE ROW LEVEL SECURITY;
  GRANT DELETE ON payroll_bank_details TO app_user, platform_admin;`;

const legacy = (db: PoolClient, emp: string, account: string, active: boolean, from: string) => db.query(
  `INSERT INTO payroll_bank_details (employee_id, bank_name, account_number, branch_code, is_active, effective_from)
   VALUES ($1, 'Legacy', $2, '250655', $3, $4) RETURNING id`, [emp, account, active, from]);

async function replay(fn: (db: PoolClient, notices: string[]) => Promise<void>): Promise<void> {
  const db = await pool.connect();
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => notices.push(n.message ?? '');
  db.on('notice', onNotice);
  try {
    await db.query('BEGIN');
    await db.query(UNDO_952);
    await db.query('ALTER ROLE CURRENT_USER NOSUPERUSER');
    await fn(db, notices);
  } finally {
    db.off('notice', onNotice);
    await db.query('ROLLBACK');
    db.release();
  }
}

describe('952 on legacy rows, as the non-superuser deploy role', () => {
  it('is not a superuser here', async () => {
    await replay(async (db) => {
      expect((await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0])
        .toEqual({ rolsuper: false, rolbypassrls: true });
    });
  });

  it('backfills each row from its own employee, keeps the newest active row, records nothing', async () => {
    const empA = await employee(pool, A);
    const empB = await employee(pool, B);
    await replay(async (db, notices) => {
      const older = (await legacy(db, empA, '100000001', true, '2024-01-01')).rows[0].id;
      const newest = (await legacy(db, empA, '100000002', true, '2025-01-01')).rows[0].id;
      const retired = (await legacy(db, empA, '100000003', false, '2023-01-01')).rows[0].id;
      const other = (await legacy(db, empB, '200000001', true, '2024-01-01')).rows[0].id;

      await db.query(SQL);

      const { rows } = await db.query('SELECT id, company_id, is_active FROM payroll_bank_details WHERE id = ANY($1)',
        [[older, newest, retired, other]]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(newest)).toMatchObject({ company_id: A, is_active: true });
      expect(byId.get(older)).toMatchObject({ company_id: A, is_active: false });
      expect(byId.get(retired)).toMatchObject({ company_id: A, is_active: false });
      expect(byId.get(other)).toMatchObject({ company_id: B, is_active: true });
      expect(notices.filter((n) => n.startsWith('migration 952:'))).toEqual([
        'migration 952: deactivated 1 superseded active payroll_bank_details row(s)']);
      const history = await db.query('SELECT 1 FROM entity_changes WHERE entity_id = ANY($1)', [[older, newest, retired, other]]);
      expect(history.rowCount).toBe(0);
    });
  });

  it('leaves the FK validated, the column NOT NULL, and can run twice', async () => {
    await replay(async (db) => {
      await db.query(SQL);
      await db.query(SQL);
      const fk = await db.query(`SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'payroll_bank_details'::regclass AND conname = 'payroll_bank_details_company_id_fkey'`);
      expect(fk.rows).toEqual([{ convalidated: true }]);
      const col = await db.query(`SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'payroll_bank_details' AND column_name = 'company_id'`);
      expect(col.rows).toEqual([{ is_nullable: 'NO' }]);
    });
  });
});

describe('no request role deletes a row; the seed and an employee\'s delete still do', () => {
  async function entered(): Promise<string> {
    const e = await employee(pool, A);
    expect((await put(tokens[o]!, A, e, ROW)).state.statusCode).toBe(200);
    return e;
  }

  it('app_user holds no DELETE, whatever the role in the company', async () => {
    const e = await entered();
    expect(await outcome(asApp(pool, o, A, (db) => db.query('DELETE FROM payroll_bank_details WHERE employee_id = $1', [e]))))
      .toMatch(/^42501/);
    expect(await rowsOf(pool, e)).toHaveLength(1);
  });

  // scripts/seed-payroll-data.ts: cleanExisting() on MIGRATION_ADMIN_DATABASE_URL, its documented connection.
  it('the seed\'s sweep works as migration_admin, under forced RLS', async () => {
    const e = await entered();
    await as(pool, o, { role: 'migration_admin', claims: null }, (db) => db.query(
      'DELETE FROM payroll_bank_details WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id = $1)', [A]));
    expect(await rowsOf(pool, e)).toHaveLength(0);
  });

  it('deleting the employee as app_user removes the rows through the cascade, and records the delete', async () => {
    const e = await entered();
    const [row] = await rowsOf(pool, e);
    await asApp(pool, o, A, (db) => db.query('DELETE FROM payroll_employees WHERE id = $1', [e]));
    expect(await rowsOf(pool, e)).toHaveLength(0);
    const { rows } = await pool.query("SELECT op FROM entity_changes WHERE entity_id = $1 ORDER BY seq", [row!.id]);
    expect(rows.map((r) => r.op)).toEqual(['create', 'delete']);
  });
});
