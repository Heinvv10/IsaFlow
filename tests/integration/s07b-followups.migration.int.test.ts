// tests/integration/s07b-followups.migration.int.test.ts
//
// S-07b follow-ups: migrations 918 (users.email off app_service) and 919 (the
// AR view-summary matview behind a company-filtered definer). Each applies
// twice, after 915-917, as a NON-superuser postgres, as production's deploy
// runs, and each DO guard refuses the re-grant it exists for. What they close:
// s07b-followups.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { doBlock, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const S07B = ['915_app_pool_login_roles.sql', '915b_app_login_role_violations.sql', '916_service_role_member_guards.sql',
  '917_app_role_hardening.sql'].map(migration);
const M918 = migration('918_users_email_off_service_pool.sql');
const M919 = migration('919_ar_view_summary_company_wrapper.sql');
const GUARD_918 = doBlock(M918, 'can UPDATE users.email');
const GUARD_919 = doBlock(M919, 'can SELECT the materialized view');

beforeAll(() => setup(ids), 60000);
afterAll(() => teardown(ids, []));

type Q = (text: string) => Promise<unknown>;
const one = async <T>(q: Q, text: string): Promise<T> => ((await q(text)) as { rows: T[] }).rows[0]!;

describe('S-07b follow-ups: migrations 918 and 919', () => {
  it('re-apply after 915-917 as a NON-superuser postgres, twice', async () => {
    await rolledBack(async (q) => {
      expect((await one<{ s: boolean }>(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user')).s).toBe(true);
      await q('ALTER ROLE postgres NOSUPERUSER');
      for (let i = 0; i < 2; i++) for (const m of [...S07B, M918, M919]) await q(m);
      expect((await one<{ s: boolean }>(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user')).s).toBe(false);
    });
  });

  it('918 leaves migration_admin, which change-email and the erasure now write on, able to write users.email', async () => {
    await rolledBack(async (q) => {
      await q(M918);
      expect(await one(q, `SELECT has_column_privilege('migration_admin', 'public.users', 'email', 'UPDATE') AS e,
        has_column_privilege('app_service', 'public.users', 'email', 'UPDATE') AS s`)).toEqual({ e: true, s: false });
    });
  });

  it.each([
    ['the column re-granted to app_service', 'GRANT UPDATE (email) ON public.users TO app_service', /918: app_service \(reachable from an app pool login\) can UPDATE users\.email/],
    ['the table granted to isaflow_service', 'GRANT UPDATE ON public.users TO isaflow_service', /918: isaflow_service \(reachable from an app pool login\) can UPDATE users\.email/],
    ['the column granted to app_user', 'GRANT UPDATE (email) ON public.users TO app_user', /918: app_(service|user) \(reachable from an app pool login\) can UPDATE users\.email/],
    ['the column granted to PUBLIC', 'GRANT UPDATE (email) ON public.users TO PUBLIC', /918: \w+ \(reachable from an app pool login\) can UPDATE users\.email/],
  ])('918\'s guard refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(M918);
      await q(mutate);
      await expect(q(GUARD_918)).rejects.toThrow(msg);
    });
  });

  it.each([
    ['SELECT re-granted to app_user', 'GRANT SELECT ON public.customer_invoice_view_summary TO app_user',
      /919: app_(service|user) \(reachable from an app pool login\) can SELECT the materialized view customer_invoice_view_summary/],
    ['SELECT granted to PUBLIC', 'GRANT SELECT ON public.customer_invoice_view_summary TO PUBLIC',
      /919: \w+ \(reachable from an app pool login\) can SELECT the materialized view customer_invoice_view_summary/],
    ['a new matview granted to app_service', `CREATE MATERIALIZED VIEW public.s07b_mutant_mv AS SELECT 1 AS x;
      GRANT SELECT ON public.s07b_mutant_mv TO app_service`, /919: app_service \(reachable from an app pool login\) can SELECT the materialized view s07b_mutant_mv/],
  ])('919\'s guard refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(M919);
      await q(mutate);
      await expect(q(GUARD_919)).rejects.toThrow(msg);
    });
  });

  it('919\'s wrapper is a definer with pg_temp last, executable by app_user and not by PUBLIC', async () => {
    await rolledBack(async (q) => {
      await q(M919);
      expect(await one(q, `SELECT p.prosecdef AS d, p.proconfig AS c,
          has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
          EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
        FROM pg_proc p WHERE p.oid = 'public.current_company_invoice_view_summary()'::regprocedure`))
        .toEqual({ d: true, c: ['search_path=pg_catalog, public, pg_temp'], app_user: true, public: false });
    });
  });
});
