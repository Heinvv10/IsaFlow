// tests/integration/mcp-connector-default-on.migration.int.test.ts
//
// Migration 1058: the MCP connector is on by default for NEW companies (enable_mcp_connector_default, called
// inside create_company_with_owner), and an owner or admin switches it with mcp_connector_self_serve_set. A
// platform admin's OFF is a lock; every UPDATE of company_feature_overrides is stamped platform_admin. Runs on
// the schema fixture with 1058 applied (the integration runner applies the branch's migrations); every case
// runs in a transaction that is rolled back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSql } from '../../scripts/_pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds(); // setup: ids.company has ids.me (admin) and ids.owner (owner); an enabled platform row for ids.company
const M1058 = migration('1058_mcp_connector_default_on_self_serve.sql');

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, [getAuthPool()]); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;

/** Act as app_user, signed in as `user`, with `company` as the session company (transaction-local). */
async function asAppUser(q: Q, user: string, company: string): Promise<void> {
  await q(`SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: user, role: 'authenticated' })}', true)`);
  await q(`SELECT set_config('app.current_company_id', '${company}', true)`);
  await q('SET LOCAL ROLE app_user');
}

const toggle = (q: Q, company: string, on: boolean) =>
  rows(q, `SELECT * FROM public.mcp_connector_self_serve_set('${company}'::uuid, ${on})`);

const override = (q: Q, company: string) => rows(q, `SELECT o.enabled, o.set_via, o.set_by::text AS set_by, o.reason
  FROM company_feature_overrides o JOIN feature_flags ff ON ff.id = o.feature_id
 WHERE o.company_id = '${company}' AND ff.code = 'mcp_connector'`);

describe('1058: the migration', () => {
  it('applies again as a NON-superuser postgres; no violation after', async () => {
    await rolledBack(async (q) => {
      await q('ALTER ROLE postgres NOSUPERUSER');
      await q(M1058);
      expect(await rows(q, 'SELECT * FROM public.app_pool_reach_violations()')).toEqual([]);
    });
  });

  it('app_user cannot execute enable_mcp_connector_default; it can execute the toggle; PUBLIC neither', async () => {
    await rolledBack(async (q) => {
      expect(await rows(q, `SELECT
          has_function_privilege('app_user', 'public.enable_mcp_connector_default(uuid, uuid)', 'EXECUTE') AS d,
          has_function_privilege('app_user', 'public.mcp_connector_self_serve_set(uuid, boolean)', 'EXECUTE') AS t,
          has_function_privilege('public', 'public.mcp_connector_self_serve_set(uuid, boolean)', 'EXECUTE') AS p`))
        .toEqual([{ d: false, t: true, p: false }]);
    });
  });
});

describe('1058: default-on', () => {
  it('create_company_with_owner as app_user leaves one enabled default_new_company row, set_by the caller', async () => {
    await rolledBack(async (q) => {
      await asAppUser(q, ids.me, ids.company);
      const created = await rows(q, `SELECT id::text AS id FROM public.create_company_with_owner('{"name": "1058 new co"}'::jsonb)`);
      await q('RESET ROLE');
      expect(await override(q, created[0]!.id as string)).toEqual([
        { enabled: true, set_via: 'default_new_company', set_by: ids.me, reason: 'Default on for new companies' },
      ]);
    });
  });

  it('an older company is untouched, and an existing row is never overwritten', async () => {
    await rolledBack(async (q) => {
      await q(`UPDATE companies SET created_at = now() - interval '1 day' WHERE id = '${ids.other}'`);
      expect(await rows(q, `SELECT public.enable_mcp_connector_default('${ids.other}'::uuid, '${ids.admin}'::uuid) AS w`)).toEqual([{ w: false }]);
      expect(await override(q, ids.other)).toEqual([]);
      await q(`UPDATE company_feature_overrides SET enabled = false WHERE company_id = '${ids.company}'`);
      await q(`UPDATE companies SET created_at = now() WHERE id = '${ids.company}'`);
      expect(await rows(q, `SELECT public.enable_mcp_connector_default('${ids.company}'::uuid, '${ids.admin}'::uuid) AS w`)).toEqual([{ w: false }]);
      expect((await override(q, ids.company))[0]).toMatchObject({ enabled: false, set_via: 'platform_admin' });
    });
  });
});

describe('1058: the owner/admin toggle', () => {
  it.each([['owner', 'owner'], ['admin', 'me']] as const)('%s switches it off then on: ok, stamped company_admin', async (_, who) => {
    await rolledBack(async (q) => {
      const user = ids[who];
      await asAppUser(q, user, ids.company);
      expect((await toggle(q, ids.company, false))[0]).toMatchObject({ result: 'ok', was_enabled: true, was_set_via: 'platform_admin' });
      expect((await toggle(q, ids.company, false))[0]).toMatchObject({ result: 'unchanged' });
      expect((await toggle(q, ids.company, true))[0]).toMatchObject({ result: 'ok', was_enabled: false, was_set_via: 'company_admin' });
      await q('RESET ROLE');
      expect((await override(q, ids.company))[0]).toMatchObject({ enabled: true, set_via: 'company_admin', set_by: user });
    });
  });

  it.each(['manager', 'viewer'])('a %s is forbidden and nothing is written', async (role) => {
    await rolledBack(async (q) => {
      await q(`UPDATE company_users SET role = '${role}' WHERE company_id = '${ids.company}' AND user_id = '${ids.me}'`);
      await asAppUser(q, ids.me, ids.company);
      expect((await toggle(q, ids.company, false))[0]).toMatchObject({ result: 'forbidden' });
      await q('RESET ROLE');
      expect((await override(q, ids.company))[0]).toMatchObject({ enabled: true, set_via: null });
    });
  });

  it('a non-member, and a forged other-company p_company, are forbidden', async () => {
    await rolledBack(async (q) => {
      await asAppUser(q, ids.invitee, ids.company);
      expect((await toggle(q, ids.company, false))[0]).toMatchObject({ result: 'forbidden' });
      await q('RESET ROLE');
      await asAppUser(q, ids.owner, ids.company);
      expect((await toggle(q, ids.other, true))[0]).toMatchObject({ result: 'forbidden' });
      await q('RESET ROLE');
      expect(await override(q, ids.other)).toEqual([]);
    });
  });

  it('a platform admin OFF is a lock: owner ON is locked; owner OFF then ON is ok', async () => {
    await rolledBack(async (q) => {
      await q(`UPDATE company_feature_overrides SET enabled = false WHERE company_id = '${ids.company}'`);
      await asAppUser(q, ids.owner, ids.company);
      expect((await toggle(q, ids.company, true))[0]).toMatchObject({ result: 'locked', was_set_via: 'platform_admin' });
      await q('RESET ROLE');
      expect((await override(q, ids.company))[0]).toMatchObject({ enabled: false, set_via: 'platform_admin' });
    });
  });

  it('an admin UPDATE over a company_admin row is stamped platform_admin (so its OFF locks)', async () => {
    await rolledBack(async (q) => {
      await asAppUser(q, ids.owner, ids.company);
      await toggle(q, ids.company, false);
      await toggle(q, ids.company, true);
      await q('RESET ROLE');
      // pre-1058 admin code: an upsert that never names set_via
      await q(`UPDATE company_feature_overrides SET enabled = false, set_via = 'company_admin' WHERE company_id = '${ids.company}'`);
      expect((await override(q, ids.company))[0]).toMatchObject({ enabled: false, set_via: 'platform_admin' });
      await asAppUser(q, ids.owner, ids.company);
      expect((await toggle(q, ids.company, true))[0]).toMatchObject({ result: 'locked' });
    });
  });

  it('an in-flight owner toggle holds the advisory lock a platform-admin OFF also takes', async () => {
    // Two connections: the owner transaction keeps the advisory key until ROLLBACK, so anything taking the
    // same key (both platform-admin writes) must wait, not sneak an OFF in after the read.
    const owner = await fixture.connect();
    const admin = await fixture.connect();
    const q = (c: typeof owner) => (text: string) => c.query(text);
    try {
      await owner.query('BEGIN');
      await asAppUser(q(owner), ids.owner, ids.company);
      expect((await toggle(q(owner), ids.company, false))[0]).toMatchObject({ result: 'ok' });

      await admin.query('BEGIN');
      await admin.query("SET LOCAL lock_timeout = '250ms'");
      // The key alone, nothing else: a row lock cannot explain this wait (the admin writes themselves are
      // proved to take this key in mcp-connector-1058-locks.int.test.ts).
      await expect(admin.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('mcp_connector_self_serve:' || $1::text, 0))`, [ids.company],
      )).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
      await admin.query('ROLLBACK').catch(() => undefined);
      owner.release();
      admin.release();
    }
  });
});
