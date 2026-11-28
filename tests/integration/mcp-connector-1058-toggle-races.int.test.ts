// tests/integration/mcp-connector-1058-toggle-races.int.test.ts
//
// Migration 1058: the owner/admin toggle against a writer that takes NO advisory key, as pre-1058 code does during
// a blue/green overlap or after a code-only rollback (its platform-admin upsert). That writer's transaction is held
// open, the toggle starts and blocks on it, then the writer commits. The toggle must decide on the row as it is
// now, never on what it read before blocking: a platform-admin OFF that landed meanwhile is a lock it keeps.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { PoolClient } from 'pg';
import { closeSql } from '../../scripts/_pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds(); // setup: ids.company has ids.owner (owner); an enabled platform row for ids.company
const FLAG = `(SELECT id FROM feature_flags WHERE code = 'mcp_connector')`;

beforeAll(() => setup(ids), 60000);
afterAll(async () => { await closeSql(); await teardown(ids, [getAuthPool()]); });
// Back to setup's committed state: one enabled row, set_via NULL.
afterEach(async () => {
  await fixture.query(`DELETE FROM company_feature_overrides WHERE company_id = $1`, [ids.company]);
  await fixture.query(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
    SELECT $1, id, true, $2 FROM feature_flags WHERE code = 'mcp_connector'`, [ids.company, ids.admin]);
});

/** Commit `set_via`/`enabled` as the starting row (none: no row at all). */
async function start(row: { enabled: boolean; set_via: string } | 'none'): Promise<void> {
  await fixture.query(`DELETE FROM company_feature_overrides WHERE company_id = $1`, [ids.company]);
  if (row === 'none') return;
  await fixture.query(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by, set_via)
    SELECT $1, id, $2, $3, $4 FROM feature_flags WHERE code = 'mcp_connector'`, [ids.company, row.enabled, ids.owner, row.set_via]);
}

const current = async () => (await fixture.query(`SELECT o.enabled, o.set_via FROM company_feature_overrides o
  WHERE o.company_id = $1 AND o.feature_id = ${FLAG}`, [ids.company])).rows;

/**
 * `oldWriter` runs in an open transaction on one connection; the owner's toggle to `on` starts on another and must
 * be seen blocked on it (a transaction lock in pg_locks) before the writer commits. Returns the toggle's answer.
 */
async function race(oldWriter: string, on: boolean): Promise<Record<string, unknown>> {
  const writer = await fixture.connect();
  const owner: PoolClient = await fixture.connect();
  try {
    await writer.query('BEGIN');
    await writer.query(oldWriter, [ids.company, ids.admin]);
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ids.owner, role: 'authenticated' })]);
    await owner.query(`SELECT set_config('app.current_company_id', $1, true)`, [ids.company]);
    await owner.query('SET LOCAL ROLE app_user');
    const pid = (await owner.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;

    const answer = owner.query(`SELECT * FROM public.mcp_connector_self_serve_set($1::uuid, $2)`, [ids.company, on]);
    answer.catch(() => undefined); // awaited below; no unhandled rejection while we poll
    let blocked = false;
    for (let i = 0; i < 50 && !blocked; i++) {
      const r = await fixture.query(`SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'transactionid' AND NOT granted`, [pid]);
      blocked = r.rowCount === 1;
      if (!blocked) await new Promise((res) => setTimeout(res, 100));
    }
    expect(blocked).toBe(true);

    await writer.query('COMMIT');
    const row = (await answer).rows[0] as Record<string, unknown>;
    await owner.query('COMMIT');
    return row;
  } finally {
    await writer.query('ROLLBACK').catch(() => undefined);
    await owner.query('ROLLBACK').catch(() => undefined);
    writer.release();
    owner.release(true);
  }
}

// What pre-1058 admin code sends: an upsert that never names set_via (the stamp trigger makes its UPDATE platform_admin).
const OLD_ADMIN_OFF = `INSERT INTO company_feature_overrides (company_id, feature_id, enabled, reason, set_by, created_at)
  SELECT $1::uuid, id, false, 'compliance', $2::uuid, now() FROM feature_flags WHERE code = 'mcp_connector'
  ON CONFLICT (company_id, feature_id) DO UPDATE SET enabled = EXCLUDED.enabled, reason = EXCLUDED.reason,
    set_by = EXCLUDED.set_by, created_at = now()`;

describe('1058: the toggle keeps a platform OFF that lands while it runs', () => {
  it('owner ON over a company_admin OFF, while an old admin OFF commits: locked, the platform OFF stays', async () => {
    await start({ enabled: false, set_via: 'company_admin' });
    expect(await race(OLD_ADMIN_OFF, true)).toMatchObject({ result: 'locked', was_enabled: false, was_set_via: 'platform_admin' });
    expect(await current()).toEqual([{ enabled: false, set_via: 'platform_admin' }]);
  });

  it('owner OFF over a default ON, while an old admin OFF commits: unchanged, the OFF stays a platform lock', async () => {
    await start({ enabled: true, set_via: 'default_new_company' });
    expect(await race(OLD_ADMIN_OFF, false)).toMatchObject({ result: 'unchanged', was_enabled: false, was_set_via: 'platform_admin' });
    expect(await current()).toEqual([{ enabled: false, set_via: 'platform_admin' }]);
  });

  it('owner ON with no row, while an old admin OFF is inserted and commits: locked, not a unique-key error', async () => {
    await start('none');
    expect(await race(OLD_ADMIN_OFF, true)).toMatchObject({ result: 'locked', was_enabled: false, was_set_via: 'platform_admin' });
    expect(await current()).toEqual([{ enabled: false, set_via: null }]);
  });

  it('owner OFF over a default ON, while an old admin REMOVE commits: decided on the new state (no row), audit sees none', async () => {
    await start({ enabled: true, set_via: 'default_new_company' });
    const OLD_ADMIN_REMOVE = `DELETE FROM company_feature_overrides WHERE company_id = $1::uuid AND feature_id = ${FLAG} AND $2::uuid IS NOT NULL`;
    expect(await race(OLD_ADMIN_REMOVE, false)).toMatchObject({ result: 'ok', was_enabled: null, was_set_via: null });
    expect(await current()).toEqual([{ enabled: false, set_via: 'company_admin' }]);
  });
});
