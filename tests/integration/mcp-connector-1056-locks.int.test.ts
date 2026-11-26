// tests/integration/mcp-connector-1056-locks.int.test.ts
//
// Migration 1056, the three findings of the independent review of PR #1927:
//   1. The owner/admin toggle (SECURITY DEFINER, owned by migration_admin) must run with only the privileges
//      1056 asserts for migration_admin (SELECT, INSERT, DELETE): no row lock, which would need UPDATE.
//   2. Both platform-admin writes (featureFlagService) must really take the toggle's advisory key, so they wait
//      for an in-flight toggle even when nothing else (no row lock, no existing row) would make them wait.
//   3. The rollback's default-on DELETE (read from the migration header itself) touches mcp_connector
//      default_new_company rows only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { closeSql } from '../../scripts/_pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { als } from '@/lib/als';
import { removeCompanyFeatureOverride, setCompanyFeatureOverride } from '@/modules/admin/services/featureFlagService';
import { fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds(); // setup: ids.company has ids.me (admin) and ids.owner (owner); an enabled platform row for ids.company
const M1056 = migration('1056_mcp_connector_default_on_self_serve.sql');
const KEY = `hashtextextended('mcp_connector_self_serve:' || '${ids.company}', 0)`;

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, [getAuthPool()]); });

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;

async function asAppUser(q: Q, user: string, company: string): Promise<void> {
  await q(`SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: user, role: 'authenticated' })}', true)`);
  await q(`SELECT set_config('app.current_company_id', '${company}', true)`);
  await q('SET LOCAL ROLE app_user');
}

const toggle = (q: Q, on: boolean) => rows(q, `SELECT * FROM public.mcp_connector_self_serve_set('${ids.company}'::uuid, ${on})`);

const override = (q: Q, company: string) => rows(q, `SELECT o.enabled, o.set_via FROM company_feature_overrides o
  JOIN feature_flags ff ON ff.id = o.feature_id WHERE o.company_id = '${company}' AND ff.code = 'mcp_connector'`);

describe('1056: the toggle runs on migration_admin without UPDATE', () => {
  it('owner OFF, ON, unchanged and locked all answer with only SELECT, INSERT, DELETE on the table', async () => {
    await rolledBack(async (q) => {
      // Exactly the privileges 1056 asserts for migration_admin on this table (production's model).
      await q('REVOKE ALL ON public.company_feature_overrides FROM migration_admin');
      await q('GRANT SELECT, INSERT, DELETE ON public.company_feature_overrides TO migration_admin');
      expect(await rows(q, `SELECT has_table_privilege('migration_admin', 'public.company_feature_overrides', 'UPDATE') AS u,
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.mcp_connector_self_serve_set(uuid, boolean)'::regprocedure) AS o`))
        .toEqual([{ u: false, o: 'migration_admin' }]);
      await asAppUser(q, ids.owner, ids.company);
      expect((await toggle(q, false))[0]).toMatchObject({ result: 'ok', was_enabled: true });
      expect((await toggle(q, false))[0]).toMatchObject({ result: 'unchanged' });
      expect((await toggle(q, true))[0]).toMatchObject({ result: 'ok', was_enabled: false });
      await q('RESET ROLE');
      // No row at all (the read finds nothing), then a platform-admin OFF (the read decides 'locked').
      await q(`DELETE FROM company_feature_overrides WHERE company_id = '${ids.company}'`);
      await asAppUser(q, ids.owner, ids.company);
      expect((await toggle(q, true))[0]).toMatchObject({ result: 'ok', was_enabled: null });
      await q('RESET ROLE');
      await q(`UPDATE company_feature_overrides SET enabled = false WHERE company_id = '${ids.company}'`);
      await asAppUser(q, ids.owner, ids.company);
      expect((await toggle(q, true))[0]).toMatchObject({ result: 'locked', was_set_via: 'platform_admin' });
    });
  });
});

/**
 * `holder` takes ONLY the advisory key (no row lock, no write). `write` runs the real service function on
 * `admin`, inside a platform-admin transaction bound through ALS as the admin routes do. It must still be
 * waiting on the advisory lock while the key is held, and finish once it is released.
 */
async function waitsForKey(prepare: (admin: PoolClient) => Promise<void>, write: () => Promise<unknown>,
  after: (q: Q) => Promise<void>): Promise<void> {
  const holder = await fixture.connect();
  const admin = await fixture.connect();
  try {
    await admin.query('BEGIN');
    await prepare(admin);
    await admin.query('SET LOCAL ROLE platform_admin');
    const adminPid = (await admin.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(${KEY})`);

    let finished = false;
    const running = als.run({ client: admin, userId: ids.admin, claims: {} }, write).then(() => { finished = true; });
    let waiting = false;
    for (let i = 0; i < 50 && !waiting; i++) {
      const r = await fixture.query(`SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`, [adminPid]);
      waiting = r.rowCount === 1;
      if (!waiting) await new Promise((res) => setTimeout(res, 100));
    }
    expect(finished).toBe(false);
    expect(waiting).toBe(true);

    await holder.query('ROLLBACK');
    await running;
    expect(finished).toBe(true);
    await after((t) => admin.query(t));
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await admin.query('ROLLBACK').catch(() => undefined);
    holder.release();
    admin.release(true);
  }
}

describe('1056: both platform-admin writes take the toggle advisory key', () => {
  let feature = '';
  beforeAll(async () => {
    feature = (await fixture.query(`SELECT id::text AS id FROM feature_flags WHERE code = 'mcp_connector'`)).rows[0].id as string;
  });

  it('setCompanyFeatureOverride (OFF, no override row exists) waits for the key, then writes a platform_admin OFF', async () => {
    await waitsForKey(
      async (c) => { await c.query(`DELETE FROM company_feature_overrides WHERE company_id = $1`, [ids.company]); },
      () => setCompanyFeatureOverride(ids.company, feature, false, 'compliance', ids.admin),
      async (q) => { expect(await override(q, ids.company)).toEqual([{ enabled: false, set_via: 'platform_admin' }]); },
    );
  });

  it('removeCompanyFeatureOverride waits for the key, then removes the row', async () => {
    let removed: boolean | null = null;
    await waitsForKey(
      async () => undefined,
      async () => { removed = await removeCompanyFeatureOverride(ids.company, feature); },
      async (q) => { expect(await override(q, ids.company)).toEqual([]); },
    );
    expect(removed).toBe(true);
  });
});

/** A ROLLBACK step of the 1056 header, as an operator would paste it: from `marker` to the first `;`. */
function rollbackStep(marker: string): string {
  const lines = M1056.slice(M1056.indexOf(marker)).split('\n').slice(1);
  const out: string[] = [];
  for (const line of lines) {
    const text = line.replace(/^(--\s*)+/, '');
    if (out.length === 0 && !text.startsWith('DELETE')) continue;
    out.push(text);
    if (text.trimEnd().endsWith(';')) break;
  }
  return out.join('\n');
}

describe('1056: the rollback', () => {
  it('step 2 deletes mcp_connector default_new_company rows only, whatever the reason on other rows', async () => {
    const step2 = rollbackStep('-- 2. Default-on rows only');
    expect(step2).toMatch(/^DELETE FROM public\.company_feature_overrides/);
    await rolledBack(async (q) => {
      // A platform-admin mcp_connector lock that happens to carry the same reason: kept.
      await q(`UPDATE company_feature_overrides SET enabled = false, reason = 'Default on for new companies' WHERE company_id = '${ids.company}'`);
      const other = (await rows(q, `INSERT INTO feature_flags (code, name) VALUES ('zz_1056_rb_${ids.company.slice(0, 8)}', 'x') RETURNING id::text AS id`))[0]!.id;
      // Another feature's row with the default-on reason AND set_via: kept.
      await q(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, reason, set_by, set_via)
        VALUES ('${ids.company}', '${other}', true, 'Default on for new companies', '${ids.admin}', 'default_new_company')`);
      // A real default-on row: deleted.
      await q(`UPDATE companies SET created_at = now() WHERE id = '${ids.other}'`);
      expect(await rows(q, `SELECT public.enable_mcp_connector_default('${ids.other}'::uuid, '${ids.admin}'::uuid) AS w`)).toEqual([{ w: true }]);

      await q(step2);

      expect(await override(q, ids.other)).toEqual([]);
      expect(await override(q, ids.company)).toEqual([{ enabled: false, set_via: 'platform_admin' }]);
      expect(await rows(q, `SELECT set_via FROM company_feature_overrides WHERE feature_id = '${other}'`)).toEqual([{ set_via: 'default_new_company' }]);
    });
  });

  it('step 3 (optional) deletes mcp_connector company_admin rows only', async () => {
    const step3 = rollbackStep('-- 3. Optional: company_admin rows');
    expect(step3).toMatch(/^DELETE FROM public\.company_feature_overrides/);
    await rolledBack(async (q) => {
      const other = (await rows(q, `INSERT INTO feature_flags (code, name) VALUES ('zz_1056_rb3_${ids.company.slice(0, 8)}', 'x') RETURNING id::text AS id`))[0]!.id;
      await q(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, reason, set_by, set_via)
        VALUES ('${ids.company}', '${other}', true, 'x', '${ids.admin}', 'company_admin')`);
      await asAppUser(q, ids.owner, ids.company);
      await toggle(q, false);
      await q('RESET ROLE');
      expect(await override(q, ids.company)).toEqual([{ enabled: false, set_via: 'company_admin' }]);

      await q(step3);

      expect(await override(q, ids.company)).toEqual([]);
      expect(await rows(q, `SELECT set_via FROM company_feature_overrides WHERE feature_id = '${other}'`)).toEqual([{ set_via: 'company_admin' }]);
    });
  });
});
