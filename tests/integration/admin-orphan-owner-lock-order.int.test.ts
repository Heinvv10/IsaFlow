/**
 * PR #1405 review round 8 (R1): removing an ORPHAN owner membership (remove-from-company's orphan path) takes its
 * locks in the member writers' order (payRunApproverGuard.ts header): the membership row, then the company's owner
 * lock (company_owners), then the pay-run approver lock. It took the approver lock before the owner lock (which the
 * role guard's DELETE trigger takes as platform_admin), and deadlocked against a concurrent removal of the company's
 * other owner, which takes owner then approver.
 *
 * Through the real route on platform_admin (the role the trigger's lock applies to). A two-stage barrier holds each
 * request right AFTER its first membership-row lock, then right AFTER its first advisory lock: under one order the
 * second request cannot take its advisory lock (the barrier releases the first after 1.5 s: serialised); under the
 * old order each holds a different advisory lock and Postgres reports the deadlock (a 5xx).
 * Expected: no 5xx; one removal succeeds and the other is refused as the last owner (409). Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const STAGES = [/\bFROM\s+(public\.)?company_users\b[\s\S]*\bFOR UPDATE\b/i, /pg_advisory_xact_lock/i];
const probe = vi.hoisted(() => ({
  stages: null as null | Array<{ arrived: number; open: () => void; opened: Promise<void> }>,
}));
function setStages() {
  probe.stages = STAGES.map(() => {
    let open = () => undefined as void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { arrived: 0, open, opened };
  });
}
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  // Not async for a plain statement: a nested sql`` fragment must stay the fragment the real tag returns.
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').trim();
    const i = STAGES.findIndex((re) => re.test(text));
    const stage = i >= 0 ? probe.stages?.[i] : undefined;
    if (!stage || stage.arrived >= 2) return realSql(strings, ...values);
    return (realSql(strings, ...values) as Promise<unknown>).then(async (result) => {
      stage.arrived += 1;
      if (stage.arrived >= 2) stage.open();
      await Promise.race([stage.opened, new Promise((resolve) => setTimeout(resolve, 1500))]);
      stage.open();
      return result;
    });
  }, realSql);
  return { ...real, sql };
});

import removeFromCompanyRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const admin = crypto.randomUUID();
const TAG = `wp14b-r9-${Date.now()}`;
const companies: string[] = [];

async function call(id: string, companyId: string) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, 'DELETE') as unknown as { body: unknown; url: string; query: Record<string, string> };
  req.query = { id };
  req.body = { company_id: companyId };
  req.url = '/api/admin/x';
  const result = response();
  await (removeFromCompanyRoute as (q: never, s: never) => Promise<unknown>)(req as never, result.res as never);
  return result.state.statusCode;
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
}, 60000);
beforeEach(async () => {
  probe.stages = null;
  await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1 OR id LIKE $2', [admin, `${TAG}%`]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

describe('R1: an orphan owner and the other owner removed at once', () => {
  it.each([1, 2, 3])('no deadlock: one removal succeeds, the other is the last owner (409), run %i', async (run) => {
    const company = crypto.randomUUID();
    companies.push(company);
    const owner = `${TAG}-owner-${run}`;
    const orphan = `${TAG}-orphan-${run}`; // no users row
    await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2)`, [company, `${TAG} co ${run}`]);
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [owner, `${owner}@test.local`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'owner')`,
      [company, owner, orphan]);
    setStages();
    const statuses = await Promise.all([call(orphan, company), call(owner, company)]);
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
    expect([...statuses].sort()).toEqual([200, 409]);
    expect((await pool.query(`SELECT count(*)::int n FROM company_users WHERE company_id = $1 AND role = 'owner'`, [company])).rows[0].n).toBe(1);
  }, 20000);
});
