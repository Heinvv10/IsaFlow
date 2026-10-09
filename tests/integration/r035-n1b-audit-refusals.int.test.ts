/**
 * R-035 N1b (A, migration 880): the migration's own "refuse to ship it any
 * other way" half, exercised (adversarial review of PR #689, REPRO 1 — every
 * other suite reads a clean fixture's end state, so a weakened assertion
 * survived them). Each case poisons the database inside one transaction, runs
 * 880's text as the deploy role, expects the refusal it names, and rolls back:
 * roles, grants and views included (all transactional).
 *
 *  - another role that inherits the table's owner (only the deploy role
 *    itself — session_user — is exempt, as in 872/#680);
 *  - a role in pg_write_all_data;
 *  - a view over audit_log, owned by a role that may erase it, with UPDATE
 *    granted to app_user (it would erase as its owner);
 *  - and the documented limit: a NOINHERIT member of the owner (it can SET
 *    ROLE to the owner) is not detected — has_table_privilege cannot see it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const MIGRATION = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/880_audit_log_append_only.sql'), 'utf8');

/** `poison`, then 880, in one transaction that is always rolled back; the error 880 raised, or 'applied'. */
async function applyAfter(poison: (c: PoolClient, role: string) => Promise<void>): Promise<string> {
  const c = await pool.connect();
  const role = `n1b_poison_${crypto.randomUUID().slice(0, 8)}`;
  try {
    await c.query('BEGIN');
    await poison(c, role);
    await c.query(MIGRATION);
    return 'applied';
  } catch (error) {
    return (error as Error).message;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const owner = async (c: PoolClient) =>
  (await c.query("SELECT relowner::regrole::text AS o FROM pg_class WHERE oid = 'public.audit_log'::regclass")).rows[0].o as string;

describe('migration 880 refuses to apply', () => {
  it('as a control, applies again on a clean database (it is idempotent)', async () => {
    expect(await applyAfter(async () => undefined)).toBe('applied');
  });

  it('while another role inherits the owner', async () => {
    const out = await applyAfter(async (c, role) => {
      await c.query(`CREATE ROLE ${role} NOLOGIN INHERIT`);
      await c.query(`GRANT ${await owner(c)} TO ${role}`);
    });
    expect(out).toMatch(/^migration 880: n1b_poison_\w+ still holds UPDATE on audit_log$/);
  });

  it('while a role is in pg_write_all_data', async () => {
    const out = await applyAfter(async (c, role) => {
      await c.query(`CREATE ROLE ${role} NOLOGIN INHERIT`);
      await c.query(`GRANT pg_write_all_data TO ${role}`);
    });
    expect(out).toMatch(/^migration 880: n1b_poison_\w+ still holds UPDATE on audit_log$/);
  });

  it('while a view over audit_log lets app_user erase through its owner', async () => {
    const out = await applyAfter(async (c, role) => {
      await c.query(`CREATE VIEW public.${role} AS SELECT * FROM public.audit_log`);
      await c.query(`GRANT SELECT, UPDATE ON public.${role} TO app_user`);
    });
    expect(out).toMatch(/^migration 880: app_user on n1b_poison_\w+ may UPDATE audit_log through a view$/);
  });

  it('LIMIT, named: NOT while a NOINHERIT member of the owner exists — it could SET ROLE, and is not detected', async () => {
    const out = await applyAfter(async (c, role) => {
      await c.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
      await c.query(`GRANT ${await owner(c)} TO ${role}`);
    });
    expect(out).toBe('applied');
  });
});
