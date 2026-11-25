/**
 * Intercompany (1002 section 6c): app_user holds no table-level UPDATE, DELETE or TRUNCATE on the group tables, so it cannot
 * LOCK TABLE them (every decider reads both: a stranger holding ACCESS EXCLUSIVE stalled every tenant's sends). It keeps INSERT,
 * SELECT and UPDATE on the columns the application writes, so every legitimate group and member write still works.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, outcome, plantConnection, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

beforeAll(() => setup(pool), 60000);
afterAll(async () => { await wipeConnections(pool); await cleanup(pool); });

const TABLES = ['company_group_members', 'company_groups'];
const priv = async (role: string, table: string, p: string) => (await pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, p])).rows[0].ok as boolean;
const col = async (table: string, column: string) => (await pool.query('SELECT has_column_privilege($1, $2, $3, $4) AS ok', ['app_user', `public.${table}`, column, 'UPDATE'])).rows[0].ok as boolean;

describe('no table-level UPDATE, DELETE or TRUNCATE for any app role', () => {
  it.each(TABLES)('%s: app_user, app_service and PUBLIC hold none; app_user keeps SELECT and INSERT', async (table) => {
    for (const role of ['app_user', 'app_service', 'public']) {
      for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) expect(await priv(role, table, p), `${role} ${p}`).toBe(false);
    }
    expect(await priv('app_user', table, 'SELECT')).toBe(true);
    expect(await priv('app_user', table, 'INSERT')).toBe(true);
  });

  it('UPDATE is granted by column, to exactly the columns the application writes', async () => {
    for (const c of ['ownership_pct', 'consolidation_method', 'left_date', 'joined_date']) expect(await col('company_group_members', c), c).toBe(true);
    for (const c of ['id', 'group_id', 'company_id', 'is_holding', 'created_at']) expect(await col('company_group_members', c), c).toBe(false);
    for (const c of ['name', 'holding_company_id', 'default_currency', 'financial_year_start', 'is_active', 'updated_at']) expect(await col('company_groups', c), c).toBe(true);
    for (const c of ['id', 'created_by', 'created_at']) expect(await col('company_groups', c), c).toBe(false);
  });
});

describe('a stranger cannot LOCK TABLE the group tables', () => {
  it.each(TABLES)('%s: every mode that blocks a reader is refused for any user, with or without claims', async (table) => {
    const modes = ['ACCESS EXCLUSIVE', 'EXCLUSIVE', 'SHARE ROW EXCLUSIVE', 'SHARE'];
    for (const user of [U.x, U.a, U.va]) {
      await asAppUser(pool, user, co.A, async (q) => {
        for (const mode of modes) expect((await outcome(q, `LOCK TABLE ${table} IN ${mode} MODE`)).slice(0, 5), `${user} ${mode}`).toBe('42501');
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      for (const mode of modes) expect((await outcome(client, `LOCK TABLE ${table} IN ${mode} MODE`)).slice(0, 5), `no claims ${mode}`).toBe('42501');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the modes it can still take (ROW EXCLUSIVE, what an INSERT takes) block no reader: a send goes through while it is held', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const stranger = await pool.connect();
    try {
      await stranger.query('BEGIN');
      await stranger.query('SET LOCAL ROLE app_user');
      for (const table of TABLES) await stranger.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
      await asAppUser(pool, U.ab, co.A, async (q) => {
        await q.query("SET LOCAL lock_timeout = '1500ms'");
        await q.query(`INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                       VALUES ($1, $2, $3, 'reject', 'payment', gen_random_uuid(), '{}')`, [id, co.A, co.B]);
      }, true);
    } finally {
      await stranger.query('ROLLBACK');
      stranger.release();
    }
  });
});

describe('the legitimate writes still work (as the application does them)', () => {
  it('a writer of the group renames it, deactivates and re-activates it, retires a member and changes ownership (the re-join upsert is exercised by company-groups-rls-refs)', async () => {
    await asAppUser(pool, U.ab, co.A, async (q) => {
      expect((await q.query('UPDATE company_groups SET name = name, default_currency = default_currency, financial_year_start = financial_year_start, holding_company_id = holding_company_id, updated_at = NOW() WHERE id = $1', [co.G])).rowCount).toBe(1);
      expect((await q.query('UPDATE company_group_members SET ownership_pct = ownership_pct, consolidation_method = consolidation_method WHERE group_id = $1 AND company_id = $2', [co.G, co.A])).rowCount).toBe(1);
      expect((await q.query('UPDATE company_groups SET is_active = false, updated_at = NOW() WHERE id = $1', [co.G])).rowCount).toBe(1);
      expect((await q.query('UPDATE company_groups SET is_active = true, updated_at = NOW() WHERE id = $1', [co.G])).rowCount).toBe(1);
    }, true);
    await asAppUser(pool, U.ab, co.B, async (q) => {       // retiring a member row is that company's own act (row security: the active company)
      expect((await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B])).rowCount).toBe(1);
    }, true);
  });

  it('a column the application never writes is refused with permission denied, not by luck of the row security', async () => {
    await asAppUser(pool, U.ab, co.A, async (q) => {
      expect((await outcome(q, 'UPDATE company_group_members SET is_holding = true WHERE group_id = $1', [co.G])).slice(0, 5)).toBe('42501');
      expect((await outcome(q, 'UPDATE company_groups SET created_by = created_by WHERE id = $1', [co.G])).slice(0, 5)).toBe('42501');
      expect((await outcome(q, 'DELETE FROM company_group_members WHERE group_id = $1', [co.G])).slice(0, 5)).toBe('42501');
      expect((await outcome(q, 'DELETE FROM company_groups WHERE id = $1', [co.G])).slice(0, 5)).toBe('42501');
    });
  });
});
