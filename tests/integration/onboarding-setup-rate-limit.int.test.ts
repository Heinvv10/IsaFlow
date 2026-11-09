/**
 * POST /api/onboarding/complete-setup: its two per-user limits, through the real withAuth, withCsrf and handler on the
 * schema fixture.
 *  - `onboarding-setup:<user>` (10/h) counts only requests that passed validation. chargeRateLimit charges BEFORE it
 *    refuses, so a refused call is shown by what it did not write (no new company, no new membership), not by the counter.
 *  - `onboarding-setup-attempt:<user>` (60/h) counts every request, refused or not, and sits before the parser, so a
 *    request it refuses must not even reach the 10/h counter.
 * The counters are seeded to the limit instead of making ten companies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { clearRateLimitCache } from '@/lib/rateLimit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callSetup, dropSetupUsers, newSetupUser, setupBody, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let u: SetupUser;
const companyName = `RATELIMIT ${crypto.randomUUID()}`;
const setupKey = () => `onboarding-setup:${u.userId}`;
const attemptKey = () => `onboarding-setup-attempt:${u.userId}`;

async function seed(key: string, count: number) {
  await pool.query(
    `INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET count = $2, window_start = NOW()`, [key, count]);
}
async function counter(key: string): Promise<number | null> {
  const r = await pool.query<{ count: number }>('SELECT count FROM rate_limit_counters WHERE key = $1', [key]);
  return r.rows[0]?.count ?? null;
}
/** The user keeps only the home membership; the named company never appears. */
async function written() {
  const c = await pool.query('SELECT count(*)::int n FROM companies WHERE name = $1', [companyName]);
  const m = await pool.query('SELECT count(*)::int n FROM company_users WHERE user_id = $1', [u.userId]);
  return { companies: c.rows[0].n as number, memberships: m.rows[0].n as number };
}
const post = () => callSetup(u, setupBody('other', { company: { name: companyName, vatPeriod: 'none', financialYearStart: 3 } }));

beforeAll(async () => { u = await newSetupUser(pool); }, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [u.userId]);
    await pool.query('DELETE FROM companies WHERE name = $1', [companyName]);
    await dropSetupUsers(pool, [u]);
  } finally { await pool.end(); }
}, 60_000);

describe('complete-setup rate limits', () => {
  // A full key is remembered in memory for a few seconds; without this the first test's refusal would answer the second.
  beforeEach(() => clearRateLimitCache());

  it('refuses the 11th validated setup in the hour with 429 and creates no company or membership', async () => {
    await seed(setupKey(), 10);
    const r = await post();
    expect(r.status, JSON.stringify(r.body)).toBe(429);
    expect(await written()).toEqual({ companies: 0, memberships: 1 });
    expect(await counter(attemptKey())).toBe(1);
  }, 30_000);

  it('refuses the 61st attempt in the hour before the 10/h counter is charged', async () => {
    await seed(attemptKey(), 60);
    await seed(setupKey(), 3);
    const r = await post();
    expect(r.status, JSON.stringify(r.body)).toBe(429);
    expect(await counter(setupKey())).toBe(3);
    expect(await written()).toEqual({ companies: 0, memberships: 1 });
  }, 30_000);
});
