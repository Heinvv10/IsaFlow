// tests/integration/signup-bureau-auto-setup.migration.int.test.ts
//
// Migration 982 adds bureaus.created_via, a partial unique index (one
// 'signup_auto' bureau per owner), the migration_admin grants the sign-up path
// writes on, a preflight that refuses to ship without them, and re-runs
// app_pool_reach_violations(). It applies twice as a NON-superuser postgres,
// as production's deploy runs; its down SQL (the header's Rollback block)
// applies, and the migration then applies again. What it enables:
// signup-bureau-auto-setup.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql } from '../../scripts/_pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { doBlock, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M982 = migration('982_bureau_signup_auto_setup.sql');
const PREFLIGHT_982 = doBlock(M982, 'which sign-up bureau setup writes on it');
const GUARD_982 = doBlock(M982, "RAISE EXCEPTION '982: %'");
/** The header's Rollback block, uncommented (the REVOKEs stay commented, as they are there). */
const DOWN_982 = M982.split('\n')
  .filter((l) => /^--\s{3}(DROP INDEX|ALTER TABLE)/.test(l))
  .map((l) => l.replace(/^--\s{3}/, ''))
  .join('\n');

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, [getAuthPool()]); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;

describe('982: migration', () => {
  it('applies twice as a NON-superuser postgres; no violation after', async () => {
    await rolledBack(async (q) => {
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) await q(M982);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
    });
  });

  it('the down SQL applies, and then the migration applies again', async () => {
    expect(DOWN_982.split('\n')).toHaveLength(3);
    await rolledBack(async (q) => {
      await q(DOWN_982);
      expect(await rows(q, `SELECT 1 FROM information_schema.columns WHERE table_name = 'bureaus' AND column_name = 'created_via'`)).toEqual([]);
      await q('ALTER ROLE postgres NOSUPERUSER');
      await q(M982);
      expect(await rows(q, `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'bureaus' AND column_name = 'created_via'`)).toEqual([{ column_default: "'admin'::text" }]);
    });
  });

  it('allows one signup_auto bureau per owner, and any number of admin ones', async () => {
    await rolledBack(async (q) => {
      const [a, b] = [ids.me, ids.owner]; // users setup seeded (owner_user_id references users)
      await q(`INSERT INTO bureaus (name, owner_user_id) VALUES ('one', '${a}'), ('two', '${a}')`);
      await q(`INSERT INTO bureaus (name, owner_user_id, created_via) VALUES ('auto', '${a}', 'signup_auto'), ('auto', '${b}', 'signup_auto')`);
      await expect(q(`INSERT INTO bureaus (name, owner_user_id, created_via) VALUES ('again', '${a}', 'signup_auto')`))
        .rejects.toThrow(/bureaus_one_signup_auto_per_owner/);
    });
  });

  it('refuses an unknown created_via', async () => {
    await rolledBack(async (q) => {
      await expect(q(`INSERT INTO bureaus (name, owner_user_id, created_via) VALUES ('x', '${ids.me}', 'self_serve')`))
        .rejects.toThrow(/bureaus_created_via_check/);
    });
  });

  it('gives migration_admin back a revoked INSERT on bureaus', async () => {
    await rolledBack(async (q) => {
      await q('REVOKE INSERT ON public.bureaus FROM migration_admin');
      await q(PREFLIGHT_982);
      expect(await rows(q, `SELECT has_table_privilege('migration_admin', 'public.bureaus', 'INSERT') AS ok`)).toEqual([{ ok: true }]);
    });
  });

  it.each([
    ['INSERT on bureaus', 'REVOKE INSERT ON public.bureaus FROM migration_admin', /982: migration_admin cannot INSERT public\.bureaus/],
    ['INSERT on bureau_users', 'REVOKE INSERT ON public.bureau_users FROM migration_admin', /982: migration_admin cannot INSERT public\.bureau_users/],
    ['INSERT on audit_log', 'REVOKE INSERT ON public.audit_log FROM migration_admin', /982: migration_admin cannot INSERT public\.audit_log/],
    ['UPDATE on users', 'REVOKE UPDATE ON public.users FROM migration_admin', /982: migration_admin cannot UPDATE users\.account_type/],
  ])('refuses to ship when the deploy role cannot grant %s', async (_, revoke, msg) => {
    await rolledBack(async (q) => {
      await q(revoke);
      // A role that owns nothing and holds no grant option: its GRANT is only a
      // warning (it needs some privilege on the table, else GRANT errors itself).
      await q('CREATE ROLE b982_no_grant NOLOGIN');
      await q('GRANT SELECT ON public.bureaus, public.bureau_users, public.audit_log, public.users TO b982_no_grant');
      await q('SET LOCAL ROLE b982_no_grant');
      await expect(q(PREFLIGHT_982)).rejects.toThrow(msg);
    });
  });

  it('refuses an app pool login that may insert bureaus', async () => {
    await rolledBack(async (q) => {
      await q(GUARD_982);
      await q('GRANT INSERT ON public.bureaus TO app_user');
      await expect(q(GUARD_982)).rejects.toThrow(/982: .*INSERT bureaus/);
    });
  });
});
