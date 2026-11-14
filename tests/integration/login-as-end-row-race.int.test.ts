/**
 * #1371 security review + re-break B3b (WP9): one `impersonation_end` row per Login-as, keyed only on what the
 * server verified (loginAsRecord.recordLoginAsEnd).
 *
 * - Two ends of one stash at once write ONE row. The race is forced at the `sql` boundary: each request is held
 *   right after its look-up for an existing row until the other has looked too, or WINDOW_MS has passed. Without
 *   the advisory lock both find none and both insert; with it the second waits for the first to commit.
 * - A forged stash cookie never reaches another session's row: an earlier Login-as of the same admin and target,
 *   or another admin's, keeps its end row untouched, and the forging session gets a row of its own.
 *
 * GoTrue is the r-032 fake (global fetch). Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { decodeJwt } from 'jose';
import endImpersonation from '../../pages/api/auth/end-impersonation';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, type Jar } from './r-032-login-as.helpers';

const race = vi.hoisted(() => ({ parties: 0, arrived: 0, open: (): void => undefined, opened: Promise.resolve() }));
const WINDOW_MS = 750;
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<typeof import('@/lib/neon')>();
  type Tx = Parameters<Parameters<typeof real.withTransaction>[0]>[0];
  const withTransaction = <T,>(fn: (tx: Tx) => Promise<T>) => real.withTransaction((tx) => fn((async (
    strings: TemplateStringsArray, ...values: unknown[]) => {
    const rows = await tx(strings, ...values);
    const text = strings.join('?');
    if (race.parties > 0 && /SELECT id FROM admin_audit_log/.test(text) && /impersonation_end/.test(text)) {
      race.arrived += 1;
      if (race.arrived >= race.parties) race.open();
      await Promise.race([race.opened, new Promise((resolve) => setTimeout(resolve, WINDOW_MS))]);
    }
    return rows;
  }) as Tx));
  return { ...real, withTransaction };
});

/** The stash delete fails once when set (after the end row is written: a 500 with the stash still live). */
const failDeleteStash = vi.hoisted(() => ({ once: false }));
vi.mock('@/modules/admin/services/userImpersonationService', async (orig) => {
  const actual = await orig<typeof import('@/modules/admin/services/userImpersonationService')>();
  return {
    ...actual,
    deleteStash: async (stashId: string) => {
      if (failDeleteStash.once) { failDeleteStash.once = false; throw new Error('wp9: stash delete failed'); }
      return actual.deleteStash(stashId);
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const fx = loginAsFixture(pool, 'WP9 end row');
const other = loginAsFixture(pool, 'WP9 end row other');

beforeAll(async () => { await fx.setUp(); await other.setUp(); }, 60000);
afterAll(async () => { try { await other.tearDown(); await fx.tearDown(); } finally { await pool.end(); } });
beforeEach(() => { race.parties = 0; failDeleteStash.once = false; });

async function end(jar: Jar) {
  const result = response();
  try {
    await (endImpersonation as (q: never, s: never) => Promise<unknown>)(request(jar, 'POST') as never, result.res as never);
  } catch { return 500; /* the route has no error wrapper: a throw is Next's 500 */ }
  return result.state.statusCode;
}
const endRows = async (admin: string) => (await pool.query(
  `SELECT id::text, details FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'impersonation_end' ORDER BY created_at`,
  [admin])).rows as { id: string; details: Record<string, unknown> }[];
const sessionOf = (jar: Jar) => decodeJwt(jar['sb-access-token']!).session_id as string;

describe('one end row per Login-as', () => {
  it('two ends of one stash at the same moment write exactly one row', async () => {
    const jar = await fx.loginAsTarget();
    const before = (await endRows(fx.platformAdmin)).length;
    race.parties = 2;
    race.arrived = 0;
    race.opened = new Promise<void>((resolve) => { race.open = resolve; });
    const statuses = await Promise.all([end(jar), end(jar)]);
    expect(statuses).toEqual([200, 200]);
    const rows = (await endRows(fx.platformAdmin)).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ stash_id: jar['sb-admin-stash'], session_id: sessionOf(jar) });
  });

  it("a forged stash cookie naming an earlier session's stash leaves that session's end row untouched", async () => {
    const first = await fx.loginAsTarget();
    expect(await end(first)).toBe(200);
    const [earlier] = (await endRows(fx.platformAdmin)).slice(-1);
    const second = await fx.loginAsTarget();
    // The second session presents the first session's (now deleted) stash id: STASH_EXPIRED. That stash is gone, so
    // nothing is recorded in anyone's name (only the presenting browser's own session is revoked).
    const before = (await endRows(fx.platformAdmin)).length;
    expect(await end({ ...second, 'sb-admin-stash': first['sb-admin-stash']! })).toBe(401);
    const rows = await endRows(fx.platformAdmin);
    expect(rows.find((r) => r.id === earlier!.id)!.details).toEqual(earlier!.details);
    expect(rows).toHaveLength(before);
    expect(await end(second)).toBe(200); // its own live stash still restores
  });

  it('re-break M4 a stash cookie swapped between two Login-as of one pair: each session keeps its own end row', async () => {
    const l1 = await fx.loginAsTarget();
    const l2 = await fx.loginAsTarget();
    failDeleteStash.once = true;
    expect(await end(l1)).toBe(500); // end row {stash k1, session s1} written, then the delete fails: k1 still live
    expect(await end({ ...l2, 'sb-admin-stash': l1['sb-admin-stash']! })).toBe(200); // l2 spends k1
    const rows = await endRows(fx.platformAdmin);
    const of = (jar: Jar) => rows.filter((r) => r.details.session_id === sessionOf(jar));
    expect(of(l1)).toHaveLength(1);
    expect(of(l2)).toHaveLength(1);
    expect(of(l1)[0]!.id).not.toBe(of(l2)[0]!.id);
  });

  it('review LOW: the end write waits at most lock_timeout (5 s) on a held end lock, then fails before anything irreversible', async () => {
    const jar = await fx.loginAsTarget();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`login-as-end:session:${sessionOf(jar)}`]);
      const t0 = Date.now();
      expect(await end(jar)).toBe(500);
      expect(Date.now() - t0).toBeLessThan(9000);
      expect((await pool.query('SELECT count(*)::int AS n FROM admin_impersonation_stash WHERE stash_id = $1',
        [jar['sb-admin-stash']])).rows[0].n).toBe(1); // still live: a retry restores
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await end(jar)).toBe(200);
  }, 20000);

  it("a forged stash cookie naming another admin's ended stash touches none of their rows", async () => {
    const theirs = await other.loginAsTarget();
    expect(await end(theirs)).toBe(200);
    const theirRows = await endRows(other.platformAdmin);
    const mine = await fx.loginAsTarget();
    expect(await end({ ...mine, 'sb-admin-stash': theirs['sb-admin-stash']! })).toBe(401);
    expect(await endRows(other.platformAdmin)).toEqual(theirRows);
    expect(await end(mine)).toBe(200);
  });
});
