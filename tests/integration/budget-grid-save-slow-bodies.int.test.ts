/**
 * Slow save bodies do not hold the auth pool (round-3 breaker P, HIGH): as many saves as the auth
 * pool has connections, two per user (the per-user cap on early reads), each send 10 bytes and
 * stall; meanwhile no backend sits idle inside a transaction and an unrelated read (a viewer's
 * grid GET) answers while every one of them is still waiting for its body (an order of events,
 * not a wall-clock bound). Before the fix every
 * stalled save held a connection inside withAuth's transaction and the read waited ~15 s for one.
 * Real PostgreSQL through the real routes and the real auth pool.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Readable } from 'node:stream';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import { getAuthPool } from '@/lib/auth/authPool';
import { earlyReadStats } from '@/lib/readJsonBody';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { TOKEN_SQL } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let A: GridCo;
const owners: GridCo[] = [];

beforeAll(async () => {
  A = await fx.company();
  for (let i = 0; i < 5; i++) owners.push(await fx.company());
}, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

/** A save as `c`'s owner whose body sends 10 bytes, then the rest when `release()` is called. */
function slowSave(c: GridCo, body: unknown) {
  const json = Buffer.from(JSON.stringify(body));
  const stream = new Readable({ read() {} });
  stream.push(json.subarray(0, 10));
  const release = () => { stream.push(json.subarray(10)); stream.push(null); };
  const base = request({ 'sb-access-token': c.owner.token, active_company_id: c.id }, 'POST') as unknown as { headers: Record<string, string> };
  const req = Object.assign(stream, base, {
    url: '/api/accounting/budget-grid/save', query: {},
    headers: { ...base.headers, 'content-type': 'application/json', 'content-length': String(json.length) },
  });
  const out = response();
  const settled = { done: false };
  const status = (saveRoute as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never)
    .then(() => { settled.done = true; return out.state.statusCode; });
  return { status, release, settled };
}

describe('slow save bodies and the auth pool', () => {
  it('a full pool of stalled saves holds no connection in a transaction; a viewer read answers at once', async () => {
    const max = (getAuthPool() as unknown as { options: { max: number } }).options.max;
    const users = owners.slice(0, Math.ceil(max / 2));
    expect(users.length * 2).toBeGreaterThanOrEqual(max);
    const v = await fx.version(A, { name: 'SLOW' });
    const slows: Array<ReturnType<typeof slowSave>> = [];
    for (const c of users) {
      const cv = await fx.version(c, { name: 'SLOW' });
      const t = String((await pool.query(`SELECT ${TOKEN_SQL} t FROM budget_versions WHERE id = $1`, [cv])).rows[0].t);
      const body = { versionId: cv, expectedUpdatedAt: t, cells: [{ glAccountId: c.acct.rent, cc1Id: null, cc2Id: null, buId: null, month: FY27[0], amount: 1 }] };
      slows.push(slowSave(c, body), slowSave(c, body));
    }
    // Wait until every save is stalled inside its early read (no sleeping on a guess).
    while (earlyReadStats().reads < slows.length) await sleep(20);
    const held = (await pool.query(
      `SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`)).rows[0].n;
    const read = await fx.call(gridRoute, '/api/accounting/budget-grid', A.viewer, 'GET', { version_id: v });
    // The order of events is the assertion: the read answered while every save was still waiting for its body.
    const stillWaiting = { reads: earlyReadStats().reads, settled: slows.filter((x) => x.settled.done).length };
    for (const x of slows) x.release();
    const statuses = await Promise.all(slows.map((x) => x.status));
    expect({ max, held }).toEqual({ max, held: 0 });
    expect(read.status).toBe(200);
    expect(stillWaiting).toEqual({ reads: slows.length, settled: 0 });
    // Two saves per user with one token: the first wins, the other is STALE; none fails or hangs.
    expect(statuses.filter((s) => s === 200)).toHaveLength(users.length);
    expect(statuses.filter((s) => s === 409)).toHaveLength(users.length);
  }, 60000);
});
