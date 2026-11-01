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
  DROP POLICY payroll_detail_read ON payroll_bank_details;
  DROP POLICY payroll_detail_insert ON payroll_bank_details;
  DROP POLICY payroll_detail_update ON payroll_bank_details;
  DROP INDEX uq_payroll_bank_details_one_active;
  ALTER TABLE payroll_bank_details DROP COLUMN company_id, DROP COLUMN account_holder;
  ALTER TABLE payroll_bank_details NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE payroll_bank_details DISABLE ROW LEVEL SECURITY;
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON payroll_bank_details TO app_user, platform_admin;`;

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

describe('952\'s grants, from the widest a role could hold before it', () => {
  it('leaves app_user SELECT, INSERT and UPDATE (is_active) only, and platform_admin nothing', async () => {
    await replay(async (db) => {
      await db.query(SQL);
      const { rows } = await db.query(`SELECT
        has_table_privilege('app_user', 'payroll_bank_details', 'SELECT') AS can_read,
        has_table_privilege('app_user', 'payroll_bank_details', 'INSERT') AS can_insert,
        has_table_privilege('app_user', 'payroll_bank_details', 'UPDATE') AS update_any,
        has_column_privilege('app_user', 'payroll_bank_details', 'is_active', 'UPDATE') AS update_active,
        has_table_privilege('app_user', 'payroll_bank_details', 'DELETE, TRUNCATE') AS can_empty,
        has_any_column_privilege('platform_admin', 'payroll_bank_details', 'SELECT, INSERT, UPDATE, REFERENCES') AS admin_any,
        has_table_privilege('platform_admin', 'payroll_bank_details', 'DELETE, TRUNCATE, TRIGGER') AS admin_table`);
      expect(rows).toEqual([{ can_read: true, can_insert: true, update_any: false, update_active: true,
        can_empty: false, admin_any: false, admin_table: false }]);
    });
  });
});

describe('952 revokes what it finds, whoever holds it', () => {
  const holders = async (db: PoolClient) => (await db.query(`
    SELECT DISTINCT a.grantee::regrole::text AS role FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.oid = 'payroll_bank_details'::regclass AND a.privilege_type IN ('DELETE', 'TRUNCATE') ORDER BY 1`)).rows.map((r) => r.role);

  it.each([
    ['a role nobody listed, DELETE', 'CREATE ROLE k1_unseen NOLOGIN; GRANT DELETE ON payroll_bank_details TO k1_unseen'],
    ['a role nobody listed, TRUNCATE', 'CREATE ROLE k1_unseen NOLOGIN; GRANT TRUNCATE ON payroll_bank_details TO k1_unseen'],
    ['PUBLIC', 'GRANT DELETE, TRUNCATE ON payroll_bank_details TO PUBLIC'],
    ['a role that passed it on', `CREATE ROLE k1_unseen NOLOGIN; CREATE ROLE k1_second NOLOGIN; GRANT k1_unseen TO CURRENT_USER;
      GRANT DELETE ON payroll_bank_details TO k1_unseen WITH GRANT OPTION;
      SET LOCAL ROLE k1_unseen; GRANT DELETE ON payroll_bank_details TO k1_second; RESET ROLE`],
  ])('%s: the migration runs, and only the owner and migration_admin hold either', async (_name, grant) => {
    await replay(async (db) => {
      await db.query(grant);
      await db.query(SQL);
      expect(await holders(db)).toEqual(['migration_admin', 'postgres']);
    });
  });
});

describe('952 replaces the single policy an earlier build of it made', () => {
  it('payroll_detail_tenant does not survive it', async () => {
    await replay(async (db) => {
      await db.query('CREATE POLICY payroll_detail_tenant ON payroll_bank_details FOR ALL TO app_user USING (true)');
      await db.query(SQL);
      const { rows } = await db.query("SELECT polname FROM pg_policy WHERE polrelid = 'payroll_bank_details'::regclass ORDER BY 1");
      expect(rows.map((r) => r.polname)).toEqual(['payroll_detail_insert', 'payroll_detail_read', 'payroll_detail_update']);
    });
  });
});

describe('952 refuses to ship any other way', () => {
  const MARK = '-- ── Refuse to ship it any other way';
  const withBefore = (statement: string) => {
    expect(SQL).toContain(MARK);
    return SQL.replace(MARK, `${statement};\n${MARK}`);
  };
  const refusal = async (statement: string, role?: string): Promise<string> => {
    let out = '';
    await replay(async (db) => {
      if (role) await db.query(`CREATE ROLE ${role} NOLOGIN`);
      out = await outcome(db.query(withBefore(statement)));
    });
    return out;
  };

  it.each([
    ['app_user', 'DELETE'], ['app_user', 'TRUNCATE'], ['app_service', 'DELETE'], ['PUBLIC', 'TRUNCATE'],
  ])('%s granted %s', async (role, priv) => {
    expect(await refusal(`GRANT ${priv} ON payroll_bank_details TO ${role}`))
      .toContain(`migration 952: ${role} still holds ${priv} on payroll_bank_details`);
  });

  it('a role nobody listed', async () => {
    expect(await refusal('GRANT DELETE ON payroll_bank_details TO k1_someone_else', 'k1_someone_else'))
      .toContain('migration 952: k1_someone_else still holds DELETE on payroll_bank_details');
  });

  it('platform_admin holding anything, table or column', async () => {
    expect(await refusal('GRANT SELECT ON payroll_bank_details TO platform_admin'))
      .toContain('migration 952: platform_admin still holds a privilege');
    expect(await refusal('GRANT SELECT (bank_name) ON payroll_bank_details TO platform_admin'))
      .toContain('migration 952: platform_admin still holds a privilege');
  });

  it('app_user able to update any column but is_active', async () => {
    expect(await refusal('GRANT UPDATE (account_number) ON payroll_bank_details TO app_user'))
      .toContain('migration 952: app_user may update account_number');
  });

  it('a policy that lets app_service in by name', async () => {
    expect(await refusal('CREATE POLICY app_service_select ON payroll_bank_details FOR SELECT TO app_service USING (true)'))
      .toContain('migration 952: app_service has a policy');
  });

  it('migration_admin and the owner keep what they hold', async () => {
    await replay(async (db) => {
      await db.query(withBefore('GRANT DELETE, TRUNCATE ON payroll_bank_details TO migration_admin'));
    });
  });
});

describe('952 gives up rather than queue behind a long transaction', () => {
  it('a lock it cannot have within 5s aborts the migration with 55P03', async () => {
    const peer = await pool.connect();
    try {
      await peer.query('BEGIN');
      await peer.query('LOCK TABLE entity_changes IN ACCESS SHARE MODE');
      let out = '';
      await replay(async (db) => {
        await db.query("SET LOCAL statement_timeout = '9s'"); // without 952's own limit this ends as 57014, not a hung suite
        out = await outcome(db.query(SQL));
      });
      expect(out).toMatch(/^55P03/);
    } finally {
      await peer.query('ROLLBACK');
      peer.release();
    }
  }, 20_000);
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
