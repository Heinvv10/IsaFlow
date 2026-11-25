/**
 * Migration 1040 + the trial lifecycle candidate query, on real PostgreSQL with synthetic rows:
 * - loadTrialCandidates keeps a plain trial company and excludes demo, converted, suspended,
 *   env-excluded, long-lapsed and no-trial companies; done stages come back, released ones do not;
 * - claimStage is atomic per (company, stage); a released claim can be re-armed, a sent one cannot;
 * - the service pool (app_service, no claims) can claim and finalise through 915's mirrors, and has
 *   no DELETE; a tenant session (app_user) sees only its own company's markers.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const { loadTrialCandidates, loadOwners } = await import('@/modules/onboarding/services/trialLifecycle/candidates');
const { claimStage, finaliseStage } = await import('@/modules/onboarding/services/trialLifecycle/markers');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const DAY = 86_400_000;
const NOW = new Date();
const ids = {
  trial: crypto.randomUUID(), demo: crypto.randomUUID(), converted: crypto.randomUUID(), suspended: crypto.randomUUID(),
  excluded: crypto.randomUUID(), lapsed: crypto.randomUUID(), noTrial: crypto.randomUUID(), other: crypto.randomUUID(),
};
const owner = crypto.randomUUID();
const otherOwner = crypto.randomUUID();
let planId = '';

async function company(id: string, ageDays: number, extra: { isDemo?: boolean; status?: string; trialDays?: number | null } = {}) {
  const created = new Date(NOW.getTime() - ageDays * DAY);
  const ends = extra.trialDays === null ? null : new Date(created.getTime() + (extra.trialDays ?? 30) * DAY);
  await pool.query(
    `INSERT INTO companies (id, name, created_at, trial_ends_at, is_demo, status) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, `TL1040 ${id.slice(0, 8)}`, created, ends, extra.isDemo ?? false, extra.status ?? 'active']);
}

beforeAll(async () => {
  await company(ids.trial, 12);
  await company(ids.other, 12);
  await company(ids.demo, 12, { isDemo: true });
  await company(ids.converted, 12);
  await company(ids.suspended, 12, { status: 'suspended' });
  await company(ids.excluded, 12);
  await company(ids.lapsed, 60);
  await company(ids.noTrial, 12, { trialDays: null });
  planId = String((await pool.query(
    `INSERT INTO plans (code, name, monthly_price_cents, annual_price_cents) VALUES ($1, 'TL1040 paid', 1000, 10000) RETURNING id`,
    [`tl1040-${crypto.randomUUID().slice(0, 8)}`])).rows[0].id);
  await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle) VALUES ($1, $2, 'active', 'monthly')`, [ids.converted, planId]);
  for (const [u, c] of [[owner, ids.trial], [otherOwner, ids.other]] as const) {
    await pool.query("INSERT INTO users (id, email, role, is_active, first_name) VALUES ($1, $2, 'admin', true, 'Sam')", [u, `${u}@test.local`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [c, u]);
  }
  process.env.TRIAL_EMAIL_EXCLUDE_COMPANY_IDS = ids.excluded;
}, 60_000);

afterAll(async () => {
  delete process.env.TRIAL_EMAIL_EXCLUDE_COMPANY_IDS;
  try {
    const all = Object.values(ids);
    await pool.query('DELETE FROM trial_lifecycle_emails WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, otherOwner]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [all]);
    await pool.query('DELETE FROM plans WHERE id = $1', [planId]);
  } finally { await pool.end(); }
});

/** A transaction as `role` (app_user: a member of `co`); always rolled back. */
async function asRole<T>(role: 'app_user' | 'app_service', co: string | null, user: string | null, fn: (q: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    if (user) await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    if (co) await client.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
    return await fn((t, p) => client.query(t, p as unknown[]));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('1040: candidates', () => {
  it('keeps the plain trial company and excludes demo, converted, suspended, env-excluded, lapsed and no-trial', async () => {
    const got = new Set((await loadTrialCandidates(NOW)).map((c) => c.companyId));
    expect(got.has(ids.trial)).toBe(true);
    for (const k of ['demo', 'converted', 'suspended', 'excluded', 'lapsed', 'noTrial'] as const) expect(got.has(ids[k]), k).toBe(false);
  });

  it('owners of the company only', async () => {
    expect((await loadOwners(ids.trial)).map((o) => o.email)).toEqual([`${owner}@test.local`]);
  });
});

describe('1040: claims', () => {
  it('a stage is claimed once; done stages come back; released ones are re-armed, sent ones never', async () => {
    expect(await claimStage(ids.trial, 'check_in')).toBe(true);
    expect(await claimStage(ids.trial, 'check_in')).toBe(false);
    await finaliseStage(ids.trial, 'check_in', 'released', 0);
    let row = (await loadTrialCandidates(NOW)).find((c) => c.companyId === ids.trial)!;
    expect(row.doneStages).toEqual([]);
    expect(await claimStage(ids.trial, 'check_in')).toBe(true);
    await finaliseStage(ids.trial, 'check_in', 'sent', 1);
    expect(await claimStage(ids.trial, 'check_in')).toBe(false);
    row = (await loadTrialCandidates(NOW)).find((c) => c.companyId === ids.trial)!;
    expect(row.doneStages).toEqual(['check_in']);
  });

  it('the service pool claims and finalises through the mirrors, and cannot delete', async () => {
    await asRole('app_service', ids.other, null, async (q) => {
      const ins = await q(`INSERT INTO trial_lifecycle_emails (company_id, stage) VALUES ($1, 'setup_nudge')
                           ON CONFLICT (company_id, stage) DO UPDATE SET outcome = EXCLUDED.outcome
                           WHERE trial_lifecycle_emails.outcome = 'released' RETURNING id`, [ids.other]);
      expect(ins.rows).toHaveLength(1);
      await q(`UPDATE trial_lifecycle_emails SET outcome = 'sent', recipient_count = 1, sent_at = NOW() WHERE company_id = $1`, [ids.other]);
      await expect(q('DELETE FROM trial_lifecycle_emails WHERE company_id = $1', [ids.other])).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('a tenant session sees only its own company\'s markers', async () => {
    await asRole('app_user', ids.other, otherOwner, async (q) => {
      const r = await q('SELECT company_id::TEXT AS c FROM trial_lifecycle_emails');
      expect(r.rows.map((x) => x.c)).not.toContain(ids.trial);
    });
  });

  it('RLS is enabled and forced, and no app_service mirror is missing or extra', async () => {
    const r = (await pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.trial_lifecycle_emails'::regclass`)).rows[0];
    expect(r).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const drift = await pool.query(`SELECT why, what FROM public.app_service_policy_drift() WHERE tbl = 'public.trial_lifecycle_emails'::regclass`);
    expect(drift.rows).toEqual([]);
  });
});
