// tests/integration/s07e-b-routes.migration.int.test.ts
//
// Migration 946 takes INSERT, DELETE and (but for what a scan or a delivery
// stamps) UPDATE on a company's outbound routes (webhook_endpoints,
// imap_mirror_connections, sent_mirror_connections) off the app pools, keeps
// 920/930/932/936/937/945's rules in app_pool_reach_violations() and adds its
// own. It applies twice after 945, as a NON-superuser postgres as production's
// deploy runs, also on a database and tables owned by migration_admin; and every
// rule refuses the re-grant it exists for. The rules under test are read from
// the migration FILE (the function is re-created in each rolled-back
// transaction), so a rule dropped from the file turns a test red.
// What 946 closes: s07e-b-routes.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql, createSql } from '../../scripts/_pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { getAuthPool } from '@/lib/auth/authPool';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M945 = migration('945_billing_and_temp_off_app_pools.sql');
const M946 = migration('946_routes_off_app_pools.sql');
const GUARD = doBlock(M946, "RAISE EXCEPTION '946: %'");
const PREFLIGHT = doBlock(M946, 'which the code writes on it');
const FN_AT = M946.indexOf('CREATE OR REPLACE FUNCTION public.app_pool_reach_violations()');
const FN = M946.slice(FN_AT, M946.indexOf('\n$$;', FN_AT) + 4);
const STAMPS: Record<string, string[]> = {
  webhook_endpoints: ['failure_count', 'last_triggered_at'],
  imap_mirror_connections: ['last_error', 'last_scan_at', 'last_success_at', 'messages_ingested_total', 'scan_cursor', 'updated_at'],
  sent_mirror_connections: ['last_error', 'last_scan_at', 'last_success_at', 'messages_captured_total', 'messages_linked_total',
    'scan_cursor', 'updated_at'],
};
const TABLES = Object.keys(STAMPS);
// A column a scan or delivery does not stamp: the one a re-point or a revival would write.
const ROUTE: Record<string, string[]> = { webhook_endpoints: ['url', 'is_active'], imap_mirror_connections: ['imap_host', 'status'],
  sent_mirror_connections: ['imap_host', 'status'] };

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, [getAuthPool()]); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;
const R = (who: string, what: string) => new RegExp(`946: ${who} \\(reachable from an app pool login\\) can ${what}`);
const APP = '(app_(service|user)|isaflow_(app|service))';
const MASTER_GRANTS = `GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLES.map((t) => `public.${t}`).join(', ')} TO app_user`;

/** What app_user may do to the three route tables. */
async function shape(q: Q) {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    const r = await rows(q, `SELECT
      (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid = 'public.${t}'::regclass
        AND attnum > 0 AND NOT attisdropped AND has_column_privilege('app_user', attrelid, attnum, 'UPDATE')) AS update,
      has_any_column_privilege('app_user', 'public.${t}', 'INSERT') AS insert,
      has_table_privilege('app_user', 'public.${t}', 'DELETE') AS delete,
      has_table_privilege('app_user', 'public.${t}', 'TRUNCATE') AS truncate,
      (SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'public.${t}'::regclass AND attnum > 0 AND NOT attisdropped
        AND NOT has_column_privilege('app_user', attrelid, attnum, 'SELECT')) AS unreadable`);
    out[t] = r[0];
  }
  return out;
}
const CLOSED = Object.fromEntries(TABLES.map((t) => [t, { update: STAMPS[t], insert: false, delete: false, truncate: false, unreadable: 0 }]));

describe('946: migration', () => {
  it('applies twice after 945 as a NON-superuser postgres from master\'s grants; no violation after', async () => {
    await rolledBack(async (q) => {
      await q(MASTER_GRANTS);
      await q('ALTER ROLE postgres NOSUPERUSER');
      await q('SET LOCAL ROLE postgres');
      await q(M945);
      for (let i = 0; i < 2; i++) await q(M946);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
      expect(await shape(q)).toEqual(CLOSED);
    });
  });

  it('applies on a database and tables owned by migration_admin, with its grants, as production has them', async () => {
    await rolledBack(async (q) => {
      await q('ALTER DATABASE isaflow_schema_fixture OWNER TO migration_admin');
      for (const t of TABLES) await q(`ALTER TABLE public.${t} OWNER TO migration_admin`);
      await q('SET LOCAL ROLE migration_admin');
      await q(MASTER_GRANTS);
      await q('RESET ROLE');
      await q('ALTER ROLE postgres NOSUPERUSER');
      await q('SET LOCAL ROLE postgres');
      await q(M946);
      await q(M946);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
      expect(await shape(q)).toEqual(CLOSED);
    });
  });

  it('leaves the fixture closed: readable, no insert, delete or truncate, only the stamps updatable', async () => {
    expect(await shape((text) => fixture.query(text))).toEqual(CLOSED);
  });

  it.each([
    ['without the REVOKE', () => M946.replace(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON[^;]*;/, ''),
      /946: .* can (INSERT|UPDATE|DELETE|TRUNCATE) (public\.)?(webhook_endpoints|imap_mirror_connections|sent_mirror_connections)/],
    ...TABLES.map((t) => [`with UPDATE granted on all of ${t}`,
      () => M946.replace(new RegExp(`GRANT UPDATE \\([^)]*\\) ON public\\.${t} TO app_user;`), `GRANT UPDATE ON public.${t} TO app_user;`),
    new RegExp(`946: .* can UPDATE ${t}\\.`)] as const),
  ])('refuses to apply %s, from master\'s grants', async (_, text, msg) => {
    await rolledBack(async (q) => {
      await q(MASTER_GRANTS);
      const mutated = text();
      expect(mutated).not.toBe(M946);
      await expect(q(mutated)).rejects.toThrow(msg);
    });
  });

  // The block prefixes every rule's message with '946: '; these are 945's, 937's, 936's, 932's and 930's rules.
  it.each([
    ['945: a balance writable', 'GRANT UPDATE (balance_flows) ON public.flow_wallet TO app_user', R(APP, 'UPDATE flow_wallet\\.balance_flows')],
    ['945: a payment method readable', 'GRANT SELECT (payment_method_token) ON public.flow_wallet TO app_user',
      R(APP, 'SELECT public\\.flow_wallet\\.payment_method_token')],
    ['945: a payment request re-pointable', 'GRANT UPDATE (company_id) ON public.paystack_payment_requests TO app_user',
      R(APP, 'UPDATE paystack_payment_requests\\.company_id')],
    ['945: TEMPORARY back on PUBLIC', 'GRANT TEMPORARY ON DATABASE isaflow_schema_fixture TO PUBLIC', R(APP, 'create temporary objects')],
    ['937: a member role writable', 'GRANT UPDATE (role) ON public.company_users TO app_user', R(APP, 'UPDATE company_users\\.role')],
    ['937: portal password hashes readable', 'GRANT SELECT (password_hash) ON public.portal_access TO app_user',
      R(APP, 'SELECT public\\.portal_access\\.password_hash')],
    ['936: a suspension liftable', 'GRANT UPDATE (status) ON public.companies TO app_user', R(APP, 'UPDATE companies\\.status')],
    ['932: a link deletable', 'GRANT DELETE ON public.bureau_companies TO app_user', R(APP, 'DELETE bureau_companies$')],
    ['930: a PAT mintable', 'GRANT INSERT ON public.personal_access_tokens TO app_user', R(APP, 'INSERT personal_access_tokens\\.')],
  ])('keeps an older rule: %s', async (_, grant, msg) => {
    await rolledBack(async (q) => {
      await q(FN);
      await q(GUARD);
      await q(grant);
      await expect(q(GUARD)).rejects.toThrow(msg);
    });
  });

  it.each(TABLES.flatMap((t) => ['app_user', 'app_service'].flatMap((who) => [
    [`${t}: INSERT to ${who}`, `GRANT INSERT ON public.${t} TO ${who}`, R(who === 'app_user' ? APP : who, `INSERT ${t}\\.`)],
    [`${t}: DELETE to ${who}`, `GRANT DELETE ON public.${t} TO ${who}`, R(who === 'app_user' ? APP : who, `DELETE ${t}$`)],
    [`${t}: TRUNCATE to ${who}`, `GRANT TRUNCATE ON public.${t} TO ${who}`, R(who === 'app_user' ? APP : who, `TRUNCATE ${t}$`)],
    ...ROUTE[t]!.map((c) => [`${t}.${c}: UPDATE to ${who}`, `GRANT UPDATE (${c}) ON public.${t} TO ${who}`,
      R(who === 'app_user' ? APP : who, `UPDATE ${t}\\.${c}`)]),
  ])) as Array<[string, string, RegExp]>)('refuses the mutant: %s', async (_, grant, msg) => {
    await rolledBack(async (q) => {
      await q(FN);
      await q(GUARD);
      await q(grant);
      await expect(q(GUARD)).rejects.toThrow(msg);
    });
  });

  it.each(TABLES.flatMap((t) => STAMPS[t]!.map((c) => [t, c])) as Array<[string, string]>)(
    'allows what 946 leaves: UPDATE %s.%s',
    async (t, c) => {
      await rolledBack(async (q) => {
        await q(FN);
        await q(`GRANT UPDATE (${c}) ON public.${t} TO app_user, app_service`);
        await q(GUARD);
      });
    });

  it.each(TABLES.flatMap((t) => ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map((p) => [`${p} ${t}`, t, p])) as Array<[string, string, string]>)(
    'refuses a database where migration_admin cannot %s',
    async (_, t, p) => {
      await rolledBack(async (q) => {
        await q(PREFLIGHT);
        await q(`REVOKE ${p} ON public.${t} FROM migration_admin`);
        await expect(q(PREFLIGHT)).rejects.toThrow(new RegExp(`946: migration_admin cannot ${p} public\\.${t}, which the code writes on it`));
      });
    });

  it('refuses a database where migration_admin is subject to row security', async () => {
    await rolledBack(async (q) => {
      await q(PREFLIGHT);
      await q('ALTER ROLE migration_admin NOBYPASSRLS');
      await expect(q(PREFLIGHT)).rejects.toThrow(/946: migration_admin must bypass row security/);
    });
  });

  it('the deploy\'s check is clean on the fixture and reports a forged re-grant', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    const reach = (v: string[] | undefined) => (v ?? []).filter((x) => x.includes('reachable from an app pool login'));
    expect(reach(await appLoginRoleViolations(sql))).toEqual([]);
    await fixture.query('GRANT UPDATE (url) ON public.webhook_endpoints TO app_service');
    try {
      expect(await appLoginRoleViolations(sql)).toContain('app_service (reachable from an app pool login) can UPDATE webhook_endpoints.url');
    } finally {
      await fixture.query('REVOKE UPDATE (url) ON public.webhook_endpoints FROM app_service');
    }
    expect(reach(await appLoginRoleViolations(sql))).toEqual([]);
  });
});
