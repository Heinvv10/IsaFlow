/**
 * Slow save bodies do not hold the auth pool (round-3 breaker P, HIGH): as many saves as the auth
 * pool has connections each send 10 bytes and stall; meanwhile no backend sits idle inside a
 * transaction and an unrelated read (a viewer's grid GET) answers at once. Before the fix every
 * stalled save held a connection inside withAuth's transaction and the read waited ~15 s for one.
 * Real PostgreSQL through the real routes and the real auth pool.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Readable } from 'node:stream';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import { getAuthPool } from '@/lib/auth/authPool';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { TOKEN_SQL } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let A: GridCo;

beforeAll(async () => { A = await fx.company(); }, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

/** A save as the owner whose body sends 10 bytes, then the rest after `holdMs` (under the 5 s idle bound). */
function slowSave(body: unknown, holdMs: number): Promise<number> {
  const json = Buffer.from(JSON.stringify(body));
  const stream = new Readable({ read() {} });
  stream.push(json.subarray(0, 10));
  setTimeout(() => { stream.push(json.subarray(10)); stream.push(null); }, holdMs);
  const base = request({ 'sb-access-token': A.owner.token, active_company_id: A.owner.homeCompanyId }, 'POST') as unknown as { headers: Record<string, string> };
  const req = Object.assign(stream, base, {
    url: '/api/accounting/budget-grid/save', query: {},
    headers: { ...base.headers, 'content-type': 'application/json', 'content-length': String(json.length) },
  });
  const out = response();
  return (saveRoute as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never).then(() => out.state.statusCode);
}

describe('slow save bodies and the auth pool', () => {
  it('a full pool of stalled saves holds no connection in a transaction; a viewer read answers at once', async () => {
    const max = (getAuthPool() as unknown as { options: { max: number } }).options.max;
    const v = await fx.version(A, { name: 'SLOW' });
    const t = String((await pool.query(`SELECT ${TOKEN_SQL} t FROM budget_versions WHERE id = $1`, [v])).rows[0].t);
    const body = { versionId: v, expectedUpdatedAt: t, cells: [{ glAccountId: A.acct.rent, cc1Id: null, cc2Id: null, buId: null, month: FY27[0], amount: 1 }] };
    const slows = Array.from({ length: max }, () => slowSave(body, 4000));
    await sleep(1500);
    const held = (await pool.query(
      `SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`)).rows[0].n;
    const r0 = Date.now();
    const read = await fx.call(gridRoute, '/api/accounting/budget-grid', A.viewer, 'GET', { version_id: v });
    const readMs = Date.now() - r0;
    const statuses = await Promise.all(slows);
    expect({ max, held }).toEqual({ max, held: 0 });
    expect([read.status, readMs < 2000], `read took ${readMs} ms`).toEqual([200, true]);
    // One token, many saves: the first wins, the rest are STALE; none fails or hangs.
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(max - 1);
  }, 60000);
});
