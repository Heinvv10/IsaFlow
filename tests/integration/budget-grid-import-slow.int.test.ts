/**
 * Budgets P2 PR-B round 3, N4: import-preview reads the multipart upload BEFORE withAuth takes a
 * pooled connection (readJsonBody's withBodyFirst, bounded by size, a total and an idle deadline),
 * so a slow upload holds no connection idle in a transaction: with ten uploads stalled mid-body
 * by ten different members (the auth pool's default size; readJsonBody reads at most two at a time
 * per user), an unrelated GET still answers at once and no backend sits idle
 * in a transaction; released, every upload previews. A caller who fails the local CSRF or session
 * check is refused at once, its body never waited for; an upload that stalls past the idle bound
 * is a 400 REQUEST_BODY_TIMEOUT. No wall-clock guesses (round-4 de-flake): the suite waits on
 * readJsonBody's `earlyReadStats()` until the uploads are being read, asserts the ORDER (the GET
 * answers while every upload is still in flight), and stubs the idle bound to 1 s under Vitest.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { Readable } from 'node:stream';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import { earlyReadStats } from '@/lib/readJsonBody';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, clearBudgetRateCounters, type GridCo } from './helpers/budgetGridFixture';
import { signSession } from './r-032-fake-gotrue.helpers';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { downloadTemplate, multipartBody, uploadStream } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
let A: GridCo, v: string, body: Buffer;
const writers: SetupUser[] = [];

/** `body` sent as its first 200 bytes, then the rest once `release()` is called. */
function stalled(bytes: Buffer) {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const stream = Readable.from((async function* gen() { yield bytes.subarray(0, 200); await released; yield bytes.subarray(200); })());
  return { stream, release };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves once `ok()` holds (checked every 20 ms); fails after `ms`. */
async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
afterEach(() => { vi.unstubAllEnvs(); });

beforeAll(async () => {
  A = await fx.company();
  v = await fx.version(A, { name: 'Slow' });
  const t = await downloadTemplate(templateRoute, A.owner, { version_id: v, grain: 'company' });
  expect(t.status).toBe(200);
  body = multipartBody([{ field: 'versionId', value: v }, { file: 'file', content: t.file! }]);
  for (let i = 0; i < 10; i++) {
    const userId = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`, [userId, `${userId}@test.local`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)`, [A.id, userId]);
    writers.push({ userId, homeCompanyId: A.id, token: await signSession(userId, undefined, 'aal2') });
  }
}, 120000);
afterAll(async () => {
  try {
    await fx.cleanup();
    await clearBudgetRateCounters(pool, writers.map((w) => w.userId));
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [writers.map((w) => w.userId)]);
  } finally {
    await pool.end();
  }
}, 120000);

describe('N4: a slow upload holds no connection', () => {
  it('with ten uploads stalled mid-body, an unrelated GET answers and nothing is idle in a transaction', async () => {
    const before = earlyReadStats().reads;
    const slow = Array.from({ length: 10 }, () => stalled(body));
    let settled = 0;
    const uploads = slow.map((s, i) => uploadStream(previewRoute, writers[i]!, s.stream, body.length).finally(() => { settled++; }));
    await until(() => earlyReadStats().reads - before === 10, 15000, 'ten uploads being read');
    const held = (await pool.query(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`)).rows;
    const get = await fx.call(gridRoute, '/api/accounting/budget-grid', A.viewer, 'GET', { version_id: v });
    // The order is the claim: the GET has answered while every upload is still arriving.
    const inFlightWhenGetAnswered = { settled, reading: earlyReadStats().reads - before };
    for (const s of slow) s.release();
    const done = await Promise.all(uploads);
    expect(held).toEqual([]);
    expect(get.status).toBe(200);
    expect(inFlightWhenGetAnswered).toEqual({ settled: 0, reading: 10 });
    expect(done.map((r) => r.status)).toEqual(Array(10).fill(200));
  }, 120000);

  it('a caller without a CSRF match or a signed session is refused at once, its body never waited for', async () => {
    for (const [label, who, csrf, status] of [['forged session', { ...A.owner, token: 'not.a.jwt' }, true, 401], ['no CSRF header', A.owner, false, 403]] as const) {
      // The body is held back until after the answer: a refusal that arrives at all never waited for it.
      const s = stalled(body);
      const out = await uploadStream(previewRoute, who, s.stream, body.length, { csrf });
      s.release();
      expect(out.status, `${label} ${JSON.stringify(out.body).slice(0, 200)}`).toBe(status);
    }
  });

  it('an upload that stalls past the idle bound is a 400 REQUEST_BODY_TIMEOUT', async () => {
    vi.stubEnv('BODY_READ_IDLE_MS', '1000');
    const s = stalled(body);
    const out = await uploadStream(previewRoute, A.owner, s.stream, body.length);
    s.release();
    expect([out.status, out.body.error?.details?.code], JSON.stringify(out.body).slice(0, 200)).toEqual([400, 'REQUEST_BODY_TIMEOUT']);
  }, 30000);
});
