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
 *  - a view over audit_log (or over such a view), owned by a role that may
 *    erase it, with UPDATE (table or column), DELETE or TRUNCATE granted to
 *    another role (it would erase as its owner) — and not an ungranted view or
 *    a security_invoker one;
 *  - app_user having lost INSERT;
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

/** A view over `over`, with no grant but `grants` (default privileges revoked first). */
const view = async (c: PoolClient, name: string, over: string, grants: string[], invoker = false) => {
  await c.query(`CREATE VIEW public.${name} ${invoker ? 'WITH (security_invoker = true) ' : ''}AS SELECT * FROM public.${over}`);
  await c.query(`REVOKE ALL ON public.${name} FROM PUBLIC, app_user, platform_admin, migration_admin`);
  for (const g of grants) {
    const [privileges, grantee] = g.split(' TO ');
    await c.query(`GRANT ${privileges} ON public.${name} TO ${grantee}`);
  }
};

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

  it.each([
    ['UPDATE to app_user', ['SELECT, UPDATE TO app_user'], /^migration 880: app_user on n1b_poison_\w+ may UPDATE audit_log through a view$/],
    ['DELETE to platform_admin', ['DELETE TO platform_admin'], /^migration 880: platform_admin on n1b_poison_\w+ may DELETE audit_log through a view$/],
    ['a column UPDATE to app_user (R2-1)', ['UPDATE (action) TO app_user'], /^migration 880: app_user on n1b_poison_\w+ may UPDATE audit_log through a view$/],
    ['TRUNCATE to app_user', ['TRUNCATE TO app_user'], /^migration 880: app_user on n1b_poison_\w+ may TRUNCATE audit_log through a view$/],
  ])('while a view over audit_log grants %s', async (_label, grants, expected) => {
    expect(await applyAfter(async (c, role) => view(c, role, 'audit_log', grants))).toMatch(expected);
  });

  it('while a view over a view over audit_log grants DELETE to app_user (R2-2)', async () => {
    const out = await applyAfter(async (c, role) => {
      await view(c, `${role}_inner`, 'audit_log', []);
      await view(c, role, `${role}_inner`, ['DELETE TO app_user']);
    });
    expect(out).toMatch(/^migration 880: app_user on n1b_poison_\w+ may DELETE audit_log through a view$/);
  });

  it('while app_user has lost INSERT (append-only, not read-only)', async () => {
    const out = await applyAfter(async (c) => { await c.query('REVOKE INSERT ON public.audit_log FROM app_user'); });
    expect(out).toBe('migration 880: app_user lost INSERT on audit_log');
  });
});

describe('migration 880 still applies', () => {
  it('beside a view over audit_log nobody else may write', async () => {
    expect(await applyAfter(async (c, role) => view(c, role, 'audit_log', ['SELECT TO app_user']))).toBe('applied');
  });

  it("beside a security_invoker view (writes check the caller's own rights)", async () => {
    expect(await applyAfter(async (c, role) => view(c, role, 'audit_log', ['SELECT, UPDATE TO app_user'], true))).toBe('applied');
  });

  it('LIMIT, named: NOT while a NOINHERIT member of the owner exists — it could SET ROLE, and is not detected', async () => {
    const out = await applyAfter(async (c, role) => {
      await c.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
      await c.query(`GRANT ${await owner(c)} TO ${role}`);
    });
    expect(out).toBe('applied');
  });
});
