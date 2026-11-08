/**
 * POST /api/onboarding/complete-setup: its two per-user limits, through the real withAuth, withCsrf and handler on the
 * schema fixture.
 *  - `onboarding-setup:<user>` (10/h) counts only requests that passed validation. chargeRateLimit charges BEFORE it
 *    refuses, so a refused call is shown by what it did not write (no new company, no new membership), not by the counter.
 *  - `onboarding-setup-attempt:<user>` (60/h) counts every request, refused or not, and sits before the parser, so a
 *    request it refuses must not even reach the 10/h counter.
 * The counters are seeded to the limit instead of making ten companies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import handler from '../../pages/api/onboarding/complete-setup';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const user = crypto.randomUUID();
const companyName = `RATELIMIT ${user}`;
// withAuth needs a membership in the active company; the user already has this one, so "no membership written" is a count of 1.
const home = crypto.randomUUID();
const setupKey = `onboarding-setup:${user}`;
const attemptKey = `onboarding-setup-attempt:${user}`;

async function seed(key: string, count: number) {
  await pool.query(
    `INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET count = $2, window_start = NOW()`, [key, count]);
}
async function counter(key: string): Promise<number | null> {
  const r = await pool.query<{ count: number }>('SELECT count FROM rate_limit_counters WHERE key = $1', [key]);
  return r.rows[0]?.count ?? null;
}
async function written() {
  const c = await pool.query('SELECT count(*)::int n FROM companies WHERE name = $1', [companyName]);
  const m = await pool.query('SELECT count(*)::int n FROM company_users WHERE user_id = $1', [user]);
  return { companies: c.rows[0].n as number, memberships: m.rows[0].n as number };
}
async function post() {
  const jar = { 'sb-access-token': await signSession(user, crypto.randomUUID(), 'aal2'), active_company_id: home };
  const req = request(jar, 'POST') as unknown as { body: unknown; url: string };
  req.url = '/api/onboarding/complete-setup';
  req.body = { requestKey: crypto.randomUUID(), entityType: 'other', company: { name: companyName }, people: [], documents: [] };
  const result = response();
  await (handler as unknown as (q: never, s: never) => Promise<void>)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body };
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [user, `${user}@test.local`]);
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [home, `RATELIMIT HOME ${user}`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)`, [home, user]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
    await pool.query('DELETE FROM companies WHERE name = $1 OR id = $2', [companyName, home]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::text[])', [[setupKey, attemptKey]]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
}, 60_000);

describe('complete-setup rate limits', () => {
  it('refuses the 11th validated setup in the hour with 429 and creates no company or membership', async () => {
    await seed(setupKey, 10);
    const r = await post();
    expect(r.status, JSON.stringify(r.body)).toBe(429);
    expect(await written()).toEqual({ companies: 0, memberships: 1 });
  }, 30_000);

  it('refuses the 61st attempt in the hour before the 10/h counter is charged', async () => {
    await seed(attemptKey, 60);
    await seed(setupKey, 3);
    const r = await post();
    expect(r.status, JSON.stringify(r.body)).toBe(429);
    expect(await counter(setupKey)).toBe(3);
    expect(await written()).toEqual({ companies: 0, memberships: 1 });
  }, 30_000);
});
