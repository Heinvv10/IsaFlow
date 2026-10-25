// tests/integration/s07e-billing-temp.migration.int.test.ts
//
// Migration 945 makes the billing tables read-only to the app roles, hides the
// columns a charge or a top-up is made with, takes TEMPORARY off PUBLIC (and
// grants it back to every role but the app pools'), and adds those rules to
// app_pool_reach_violations() (920, 930, 932, 936, 937), which the migration
// and every deploy run. It applies twice, after 936 and 937, as a NON-superuser
// postgres, as production's deploy runs; also on a database and tables owned by
// migration_admin, as production has them; and every rule refuses the re-grant
// it exists for. What 945 closes: s07e-billing-temp.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql, createSql } from '../../scripts/_pg';
import { appLoginRoleViolations } from '../../scripts/check-app-login-roles';
import { getAuthPool } from '@/lib/auth/authPool';
import { doBlock, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const M936 = migration('936_companies_standing_columns_off_app_pools.sql');
const M937 = migration('937_credential_tables_off_app_pools.sql');
const M945 = migration('945_billing_and_temp_off_app_pools.sql');
const GUARD = doBlock(M945, "RAISE EXCEPTION '945: %'");
const PREFLIGHT = doBlock(M945, 'which the code writes on it');
const TEMP_BLOCK = doBlock(M945, 'REVOKE TEMPORARY ON DATABASE');
const HIDE_BLOCK = doBlock(M945, "ARRAY['payment_method_token']");
const BILLING = ['plans', 'plan_features', 'feature_flags', 'company_feature_overrides', 'flow_bundles', 'flow_wallet', 'flow_ledger',
  'flow_purchases', 'subscriptions', 'subscription_charges', 'subscription_mandates'];
const HIDDEN: Array<[string, string]> = [['flow_wallet', 'payment_method_token'],
  ['subscription_mandates', 'paystack_authorization_code'], ['subscription_mandates', 'paystack_customer_code'],
  ['subscription_mandates', 'paystack_subscription_code'], ['subscription_mandates', 'paystack_email_token'],
  ['subscription_charges', 'paystack_authorization_code']];

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, [getAuthPool()]); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;
const R = (who: string, what: string) => new RegExp(`945: ${who} \\(reachable from an app pool login\\) can ${what}`);
const APP = '(app_(service|user)|isaflow_(app|service))';
const MASTER_GRANTS = `GRANT SELECT, INSERT, UPDATE, DELETE ON ${BILLING.map((t) => `public.${t}`).join(', ')} TO app_user;
  GRANT TEMPORARY ON DATABASE isaflow_schema_fixture TO PUBLIC`;

/** What app_user may do to the billing tables, and whether isaflow_app may create temporary objects. */
async function shape(q: Q) {
  const writes = await rows(q, `SELECT t AS tbl, p AS priv FROM unnest(ARRAY[${BILLING.map((t) => `'public.${t}'`).join(',')}]) t,
    unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
    WHERE CASE WHEN p IN ('INSERT','UPDATE') THEN has_any_column_privilege('app_user', t, p) ELSE has_table_privilege('app_user', t, p) END`);
  const unreadable = await rows(q, `SELECT t AS tbl FROM unnest(ARRAY[${BILLING.map((t) => `'public.${t}'`).join(',')}]) t
    WHERE NOT has_any_column_privilege('app_user', t, 'SELECT')`);
  const hidden = await rows(q, `SELECT tbl, col FROM (VALUES ${HIDDEN.map(([t, c]) => `('public.${t}', '${c}')`).join(',')}) h(tbl, col)
    WHERE has_column_privilege('app_user', tbl, col, 'SELECT')`);
  const temp = await rows(q, `SELECT has_database_privilege('isaflow_app', current_database(), 'TEMPORARY') AS app,
    has_database_privilege('isaflow_service', current_database(), 'TEMPORARY') AS service,
    has_database_privilege('platform_admin', current_database(), 'TEMPORARY') AS platform_admin,
    has_database_privilege('migration_admin', current_database(), 'TEMPORARY') AS migration_admin`);
  return { writes, unreadable, hidden, temp: temp[0] };
}
const CLOSED = { writes: [], unreadable: [], hidden: [], temp: { app: false, service: false, platform_admin: true, migration_admin: true } };

describe('945: migration', () => {
  it('applies twice as a NON-superuser postgres from master\'s grants; 936, 937 and 945 re-apply; no violation after', async () => {
    await rolledBack(async (q) => {
      await q(MASTER_GRANTS);
      await q('ALTER ROLE postgres NOSUPERUSER');
      await q('SET LOCAL ROLE postgres');
      for (let i = 0; i < 2; i++) await q(M945);
      await q(M936);
      await q(M937);
      await q(M945);
      expect((await rows(q, 'SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user'))[0]!.s).toBe(false);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
      expect(await shape(q)).toEqual(CLOSED);
    });
  });

  it('applies on a database and tables owned by migration_admin, with its grants, as production has them', async () => {
    await rolledBack(async (q) => {
      await q('ALTER DATABASE isaflow_schema_fixture OWNER TO migration_admin');
      for (const t of ['plans', 'plan_features', 'feature_flags', 'company_feature_overrides', 'subscriptions']) {
        await q(`ALTER TABLE public.${t} OWNER TO migration_admin`);
      }
      await q('SET LOCAL ROLE migration_admin');
      await q(MASTER_GRANTS);
      await q('RESET ROLE');
      await q('ALTER ROLE postgres NOSUPERUSER');
      await q('SET LOCAL ROLE postgres');
      await q(M945);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
      expect(await shape(q)).toEqual(CLOSED);
      expect((await rows(q, `SELECT has_database_privilege('postgres', current_database(), 'TEMPORARY') AS t`))[0]!.t).toBe(true);
    });
  });

  it('leaves the fixture closed: SELECT on every billing table, no write, the charge columns hidden, no TEMPORARY for the app logins', async () => {
    expect(await shape((text) => fixture.query(text))).toEqual(CLOSED);
  });

  it.each([
    ['without the TEMPORARY block', () => M945.replace(TEMP_BLOCK, ''), /945: .* can create temporary objects in database/],
    ['without hiding the charge columns', () => M945.replace(HIDE_BLOCK, ''), /945: .* can (DELETE|INSERT|UPDATE|SELECT|TRUNCATE) (public\.)?(flow_wallet|subscription_mandates|subscription_charges)/],
  ])('refuses to apply %s, from master\'s grants', async (_, text, msg) => {
    await rolledBack(async (q) => {
      await q(MASTER_GRANTS);
      await expect(q(text())).rejects.toThrow(msg);
    });
  });

  it.each([
    ['a balance writable', 'GRANT UPDATE (balance_flows) ON public.flow_wallet TO app_user', R(APP, 'UPDATE flow_wallet\\.balance_flows')],
    ['a payment method writable', 'GRANT UPDATE (payment_method_token) ON public.flow_wallet TO app_service',
      R('app_service', 'UPDATE flow_wallet\\.payment_method_token')],
    ['a wallet insertable', 'GRANT INSERT (company_id) ON public.flow_wallet TO app_user', R(APP, 'INSERT flow_wallet\\.company_id')],
    ['a Flows credit recordable', 'GRANT INSERT ON public.flow_ledger TO isaflow_service', R('isaflow_service', 'INSERT flow_ledger\\.')],
    ['a purchase inflatable', 'GRANT UPDATE (flows) ON public.flow_purchases TO app_user', R(APP, 'UPDATE flow_purchases\\.flows')],
    ['a bundle inflatable', 'GRANT UPDATE ON public.flow_bundles TO app_user', R(APP, 'UPDATE flow_bundles\\.')],
    ['PAYG renamable by PUBLIC', 'GRANT UPDATE (code) ON public.plans TO PUBLIC', R('\\w+', 'UPDATE plans\\.code')],
    ['a plan feature addable', 'GRANT INSERT ON public.plan_features TO app_user', R(APP, 'INSERT plan_features\\.')],
    ['a flag made global', 'GRANT UPDATE (is_global) ON public.feature_flags TO isaflow_app', R('isaflow_app', 'UPDATE feature_flags\\.is_global')],
    ['an override deletable', 'GRANT DELETE ON public.company_feature_overrides TO app_user', R(APP, 'DELETE company_feature_overrides$')],
    ['a plan movable', 'GRANT UPDATE (plan_id) ON public.subscriptions TO app_user', R(APP, 'UPDATE subscriptions\\.plan_id')],
    ['charges truncatable', 'GRANT TRUNCATE ON public.subscription_charges TO app_user', R(APP, 'TRUNCATE subscription_charges$')],
    ['a mandate re-pointable', 'GRANT UPDATE (paystack_authorization_code) ON public.subscription_mandates TO app_user',
      R(APP, 'UPDATE subscription_mandates\\.paystack_authorization_code')],
    ['a stored payment method readable', 'GRANT SELECT (payment_method_token) ON public.flow_wallet TO app_user',
      R(APP, 'SELECT public\\.flow_wallet\\.payment_method_token')],
    ['every mandate column readable again', 'GRANT SELECT ON public.subscription_mandates TO app_user',
      R(APP, 'SELECT public\\.subscription_mandates\\.paystack_authorization_code')],
    ['a charge\'s authorisation readable', 'GRANT SELECT (paystack_authorization_code) ON public.subscription_charges TO app_service',
      R('app_service', 'SELECT public\\.subscription_charges\\.paystack_authorization_code')],
    ['a new wallet column granted before anyone decided', `ALTER TABLE public.flow_wallet ADD COLUMN x945_new text;
      GRANT UPDATE (x945_new) ON public.flow_wallet TO app_user`, R(APP, 'UPDATE flow_wallet\\.x945_new')],
    ['TEMPORARY back on PUBLIC', 'GRANT TEMPORARY ON DATABASE isaflow_schema_fixture TO PUBLIC',
      R(APP, 'create temporary objects in database isaflow_schema_fixture')],
    ['TEMPORARY for the service login', 'GRANT TEMPORARY ON DATABASE isaflow_schema_fixture TO isaflow_service',
      R('isaflow_service', 'create temporary objects')],
    ['CREATE on the database', 'GRANT CREATE ON DATABASE isaflow_schema_fixture TO app_user', R(APP, 'create schema objects')],
    ['CREATE in public', 'GRANT CREATE ON SCHEMA public TO app_user', R(APP, 'CREATE in schema public')],
    // 937's, 936's, 932's and 930's rules are kept: one of each kind.
    ['937: a member role writable', 'GRANT UPDATE (role) ON public.company_users TO app_user', R(APP, 'UPDATE company_users\\.role')],
    ['937: portal password hashes readable', 'GRANT SELECT (password_hash) ON public.portal_access TO app_user',
      R(APP, 'SELECT public\\.portal_access\\.password_hash')],
    ['936: a suspension liftable', 'GRANT UPDATE (status) ON public.companies TO app_user', R(APP, 'UPDATE companies\\.status')],
    ['932: a link deletable', 'GRANT DELETE ON public.bureau_companies TO app_user', R(APP, 'DELETE bureau_companies$')],
    ['930: a PAT mintable', 'GRANT INSERT ON public.personal_access_tokens TO app_user', R(APP, 'INSERT personal_access_tokens\\.')],
  ])('refuses the mutant: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(GUARD);
      await q(mutate);
      await expect(q(GUARD)).rejects.toThrow(msg);
    });
  });

  it.each([
    ['a new wallet column nobody granted', 'ALTER TABLE public.flow_wallet ADD COLUMN x945_quiet text'],
    ['a non-app role holding TEMPORARY', 'GRANT TEMPORARY ON DATABASE isaflow_schema_fixture TO platform_admin'],
    ['reading every plan column', 'GRANT SELECT ON public.plans TO app_user'],
  ])('allows what 945 leaves: %s', async (_, change) => {
    await rolledBack(async (q) => {
      await q(change);
      await q(GUARD);
    });
  });

  it.each([
    ['migration_admin, metering', 'REVOKE UPDATE ON public.flow_wallet FROM migration_admin',
      /945: migration_admin cannot UPDATE public\.flow_wallet, which the code writes on it/],
    ['migration_admin, the charge cron', 'REVOKE INSERT ON public.subscription_charges FROM migration_admin',
      /945: migration_admin cannot INSERT public\.subscription_charges/],
    ['migration_admin, mandates', 'REVOKE UPDATE ON public.subscription_mandates FROM migration_admin',
      /945: migration_admin cannot UPDATE public\.subscription_mandates/],
    ['platform_admin, the plans editor', 'REVOKE UPDATE ON public.plans FROM platform_admin',
      /945: platform_admin cannot UPDATE public\.plans/],
    ['platform_admin, feature overrides', 'REVOKE DELETE ON public.company_feature_overrides FROM platform_admin',
      /945: platform_admin cannot DELETE public\.company_feature_overrides/],
    ['platform_admin under row security', 'ALTER ROLE platform_admin NOBYPASSRLS',
      /945: migration_admin and platform_admin must bypass row security/],
    ['the AR view refresh\'s owner without TEMPORARY', 'ALTER FUNCTION public.refresh_customer_invoice_view_summary() OWNER TO app_user',
      /945: refresh_customer_invoice_view_summary\(\) \(owner app_user\) cannot create the temporary table/],
  ])('refuses a database where a moved write could not run: %s', async (_, mutate, msg) => {
    await rolledBack(async (q) => {
      await q(PREFLIGHT);
      await q(mutate);
      await expect(q(PREFLIGHT)).rejects.toThrow(msg);
    });
  });

  it('the deploy\'s check runs 945\'s rule', async () => {
    const url = new URL(String(fixture.options.connectionString));
    url.searchParams.set('sslmode', 'disable');
    const sql = createSql(url.toString());
    await fixture.query('GRANT UPDATE (balance_flows) ON public.flow_wallet TO app_service');
    try {
      expect(await appLoginRoleViolations(sql)).toContain(
        'app_service (reachable from an app pool login) can UPDATE flow_wallet.balance_flows');
    } finally {
      await fixture.query('REVOKE UPDATE (balance_flows) ON public.flow_wallet FROM app_service');
    }
    expect((await appLoginRoleViolations(sql))!.filter((v) => v.includes('reachable from an app pool login'))).toEqual([]);
  });
});
