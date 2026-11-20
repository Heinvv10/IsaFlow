// Migration 1010d (#1656 round 7 M4): company_user_permissions is read-only to the app pools, keeps every rule 946 had in
// app_pool_reach_violations() and adds its own. It applies twice after 946 as a NON-superuser postgres (as production's deploy runs it);
// each privilege it exists to take refuses the re-grant; migration_admin must still write the table. The rules under test are read from
// the migration FILE (the function is re-created in each rolled-back transaction), so a rule dropped from the file turns a test red.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql, createSql } from '../../scripts/_pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { getAuthPool } from '@/lib/auth/authPool';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M946 = migration('946_routes_off_app_pools.sql');
const M1010D = migration('1010d_company_user_permissions_off_app_pools.sql');
const GUARD = doBlock(M1010D, "RAISE EXCEPTION '1010d: %'");
const PREFLIGHT = doBlock(M1010D, 'which the code writes on it');
const FN_AT = M1010D.indexOf('CREATE OR REPLACE FUNCTION public.app_pool_reach_violations()');
const FN = M1010D.slice(FN_AT, M1010D.indexOf('\n$$;', FN_AT) + 4);
const T = 'company_user_permissions';
const APP = '(app_(service|user)|isaflow_(app|service))';

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, [getAuthPool()]); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;
const shape = async (q: Q) => (await rows(q, `SELECT
  (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid = 'public.${T}'::regclass
    AND attnum > 0 AND NOT attisdropped AND has_column_privilege('app_user', attrelid, attnum, 'UPDATE')) AS update,
  has_any_column_privilege('app_user', 'public.${T}', 'INSERT') AS insert,
  has_table_privilege('app_user', 'public.${T}', 'DELETE') AS delete,
  has_table_privilege('app_user', 'public.${T}', 'TRUNCATE') AS truncate,
  has_table_privilege('app_user', 'public.${T}', 'SELECT') AS read`))[0];
const CLOSED = { update: null, insert: false, delete: false, truncate: false, read: true };
/** The top-level `( ... )` rows of the `<name> (...) AS (VALUES ...)` list, whitespace-free, comments dropped. */
function valueRows(text: string, name: string): string[] {
  const body = text.replace(/--[^\n]*/g, '');
  const at = body.search(new RegExp(`${name} \\([a-z_, ]+\\) AS \\(VALUES`));
  if (at < 0) throw new Error(`no ${name} VALUES list`);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = body.indexOf('(VALUES', at); i < body.length; i++) {
    if (body[i] === '(') { depth++; if (depth === 2) start = i; }
    if (body[i] === ')') { if (depth === 2) out.push(body.slice(start, i + 1).replace(/\s+/g, '')); depth--; if (depth === 0) break; }
  }
  return out;
}

describe('1010d: migration', () => {
  it('applies twice as a NON-superuser postgres; no violation after, and app_user holds SELECT only', async () => {
    await rolledBack(async (q) => {
      await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${T} TO app_user`);
      await q('ALTER ROLE postgres NOSUPERUSER');
      await q('SET LOCAL ROLE postgres');
      for (let i = 0; i < 2; i++) await q(M1010D);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
      expect(await shape(q)).toEqual(CLOSED);
    });
  });

  it('leaves the fixture closed', async () => {
    expect(await shape((text) => fixture.query(text))).toEqual(CLOSED);
  });

  it.each(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])('refuses the mutant: %s granted back to app_user or app_service', async (priv) => {
    for (const who of ['app_user', 'app_service']) {
      await rolledBack(async (q) => {
        await q(FN);
        await q(GUARD);
        await q(`GRANT ${priv} ON public.${T} TO ${who}`);
        await expect(q(GUARD)).rejects.toThrow(new RegExp(`1010d: ${who === 'app_user' ? APP : who} \\(reachable from an app pool login\\) can ${priv}`));
      });
    }
  });

  it('refuses to apply without the REVOKE', async () => {
    await rolledBack(async (q) => {
      await q(`GRANT INSERT, UPDATE, DELETE ON public.${T} TO app_user`);
      const mutated = M1010D.replace(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON[^;]*;/, '');
      expect(mutated).not.toBe(M1010D);
      await expect(q(mutated)).rejects.toThrow(/1010d: .* can (INSERT|UPDATE|DELETE) /);
    });
  });

  it.each(['SELECT', 'INSERT', 'UPDATE', 'DELETE'])('refuses a database where migration_admin cannot %s', async (p) => {
    await rolledBack(async (q) => {
      await q(PREFLIGHT);
      await q(`REVOKE ${p} ON public.${T} FROM migration_admin`);
      await expect(q(PREFLIGHT)).rejects.toThrow(new RegExp(`1010d: migration_admin cannot ${p} public\\.${T}, which the code writes on it`));
    });
  });

  it("the deploy's check is clean on the fixture and reports a forged re-grant", async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    const reach = (v: string[] | null) => (v ?? []).filter((x) => x.includes('reachable from an app pool login'));
    expect(reach(await appLoginRoleViolations(sql))).toEqual([]);
    await fixture.query(`GRANT UPDATE (can_approve) ON public.${T} TO app_service`);
    try {
      expect(await appLoginRoleViolations(sql)).toContain(`app_service (reachable from an app pool login) can UPDATE ${T}.can_approve`);
    } finally {
      await fixture.query(`REVOKE UPDATE (can_approve) ON public.${T} FROM app_service`);
    }
    expect(reach(await appLoginRoleViolations(sql))).toEqual([]);
  });

  describe('1010d keeps every rule 946 had', () => {
    it.each(['rules', 'unreadable'])("every row of 946's %s list is in 1010d's, verbatim", (name) => {
      const kept = new Set(valueRows(M1010D, name));
      expect(valueRows(M946, name).length).toBeGreaterThan(5);
      expect(valueRows(M946, name).filter((r) => !kept.has(r))).toEqual([]);
    });
    it('1010d adds exactly company_user_permissions to the rules, and nothing to unreadable', () => {
      const added = valueRows(M1010D, 'rules').filter((r) => !valueRows(M946, 'rules').includes(r));
      expect(added).toEqual([`('public.${T}','{}','{}',true,false)`]);
      expect(valueRows(M1010D, 'unreadable')).toEqual(valueRows(M946, 'unreadable'));
    });
  });
});
