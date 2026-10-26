/**
 * Budgets P2 PR-B round 3, N4: import-preview reads the multipart upload BEFORE withAuth takes a
 * pooled connection (readJsonBody's withBodyFirst, bounded by size, a total and an idle deadline),
 * so a slow upload holds no connection idle in a transaction: with ten uploads stalled mid-body
 * (the auth pool's default size), an unrelated GET still answers at once and no backend sits idle
 * in a transaction; released, every upload previews. A caller who fails the local CSRF or session
 * check is refused at once, its body never waited for; an upload that stalls past the idle bound
 * is a 400 REQUEST_BODY_TIMEOUT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Readable } from 'node:stream';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { downloadTemplate, multipartBody, uploadStream } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
let A: GridCo, v: string, body: Buffer;

/** `body` sent as its first 200 bytes, then the rest once `release()` is called. */
function stalled(bytes: Buffer) {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const stream = Readable.from((async function* gen() { yield bytes.subarray(0, 200); await released; yield bytes.subarray(200); })());
  return { stream, release };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  A = await fx.company();
  v = await fx.version(A, { name: 'Slow' });
  const t = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain: 'company' });
  expect(t.status).toBe(200);
  body = multipartBody([{ field: 'versionId', value: v }, { file: 'file', content: t.file! }]);
}, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

describe('N4: a slow upload holds no connection', () => {
  it('with ten uploads stalled mid-body, an unrelated GET answers and nothing is idle in a transaction', async () => {
    const slow = Array.from({ length: 10 }, () => stalled(body));
    const uploads = slow.map((s) => uploadStream(previewRoute, A.owner, s.stream, body.length));
    await sleep(1500);
    const held = (await pool.query(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`)).rows;
    const get = fx.call(gridRoute, '/api/accounting/budget-grid', A.viewer, 'GET', { version_id: v });
    const first = await Promise.race([get, sleep(5000).then(() => null)]);
    for (const s of slow) s.release();
    const done = await Promise.all(uploads);
    await get;
    expect(held).toEqual([]);
    expect(first?.status).toBe(200);
    expect(done.map((r) => r.status)).toEqual(Array(10).fill(200));
  }, 120000);

  it('a caller without a CSRF match or a signed session is refused at once, its body never waited for', async () => {
    for (const [label, who, csrf, status] of [['forged session', { ...A.owner, token: 'not.a.jwt' }, true, 401], ['no CSRF header', A.owner, false, 403]] as const) {
      const s = stalled(body);
      const t0 = Date.now();
      const out = await uploadStream(previewRoute, who, s.stream, body.length, { csrf });
      s.release();
      expect([out.status, Date.now() - t0 < 2000], `${label} ${JSON.stringify(out.body).slice(0, 200)}`).toEqual([status, true]);
    }
  });

  it('an upload that stalls past the idle bound is a 400 REQUEST_BODY_TIMEOUT', async () => {
    const s = stalled(body);
    const t0 = Date.now();
    const out = await uploadStream(previewRoute, A.owner, s.stream, body.length);
    const ms = Date.now() - t0;
    s.release();
    expect([out.status, out.body.error?.details?.code], JSON.stringify(out.body).slice(0, 200)).toEqual([400, 'REQUEST_BODY_TIMEOUT']);
    expect(ms).toBeGreaterThanOrEqual(9500);
    expect(ms).toBeLessThan(16000);
  }, 30000);
});
