/**
 * The admin companies list, detail and CSV export show the plan a company is
 * on by the feature-gating rule (CURRENT_PLAN_ID_SQL, currentPlanSql.ts), not
 * by a looser one (PR #1367 review). Plan name and billing cycle come from the
 * one current subscription row.
 *   X  trial that ended 5 days ago                         -> no plan, no cycle
 *   L  trial that ends in 10 days                          -> Pro, monthly
 *   A  active                                              -> Pro, annual
 *   P  past_due                                            -> Pro, monthly
 *   N  trial with no end date on either row                -> no plan (fail closed)
 *   R  older active Starter annual, newer EXPIRED Pro trial -> Starter, annual
 * Before the fix X, N and R showed the expired/dateless trial's plan and cycle
 * while the Features tab and feature adoption gave them none (or Starter's).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import exportRoute from '../../pages/api/admin/companies/export';
import { getCompanyDetail, listCompanies } from '@/modules/admin/services/adminCompanyService';
import { pool } from './admin-metrics.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

const DAY = 86_400_000;
const tag = crypto.randomUUID().slice(0, 8);
const admin = crypto.randomUUID();
const letters = ['X', 'L', 'A', 'P', 'N', 'R'] as const;
type Letter = (typeof letters)[number];
const ids = Object.fromEntries(letters.map((l) => [l, crypto.randomUUID()])) as Record<Letter, string>;
const planNames = { pro: `CP Pro ${tag}`, starter: `CP Starter ${tag}` };
const plans: string[] = [];

async function plan(name: string, code: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO plans (code, name, monthly_price_cents, annual_price_cents) VALUES ($1, $2, 10000, 100000) RETURNING id`,
    [`${code}-${tag}`, name]);
  plans.push(r.rows[0].id as string);
  return r.rows[0].id as string;
}

async function company(letter: Letter, trialEndsAt: Date | null) {
  await pool.query(`INSERT INTO companies (id, name, status, trial_ends_at) VALUES ($1, $2, 'active', $3)`,
    [ids[letter], `CP ${letter} ${tag}`, trialEndsAt]);
}

async function sub(letter: Letter, planId: string, status: string, cycle: string, periodEnd: Date | null, createdAt = new Date()) {
  await pool.query(
    `INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle, current_period_end, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`, [ids[letter], planId, status, cycle, periodEnd, createdAt]);
}

/** The CSV the export route streams, as {company id: plan_name}. */
async function exportedPlans(): Promise<Record<string, string>> {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, 'GET') as ReturnType<typeof request> & { query: Record<string, string> };
  req.query = {};
  const result = response();
  const chunks: string[] = [];
  Object.assign(result.state, { write(chunk: string) { chunks.push(chunk); return true; } });
  await (exportRoute as (q: never, s: never) => Promise<unknown>)(req as never, result.res as never);
  expect(result.state.statusCode).toBe(200);
  const lines = chunks.join('').trim().split('\n');
  expect(lines[0]).toBe('"id","name","status","plan_name","mrr_cents","created_at","trial_ends_at","user_count"');
  const mine = new Set(Object.values(ids));
  const out: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
    if (mine.has(cells[0]!)) out[cells[0]!] = cells[3]!;
  }
  return out;
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  const pro = await plan(planNames.pro, 'cp-pro');
  const starter = await plan(planNames.starter, 'cp-starter');
  const past = new Date(Date.now() - 5 * DAY);
  const ahead = new Date(Date.now() + 10 * DAY);
  await company('X', past); await sub('X', pro, 'trial', 'monthly', past);
  await company('L', ahead); await sub('L', pro, 'trial', 'monthly', ahead);
  await company('A', null); await sub('A', pro, 'active', 'annual', null);
  await company('P', null); await sub('P', pro, 'past_due', 'monthly', null);
  await company('N', null); await sub('N', pro, 'trial', 'monthly', null);
  await company('R', past);
  await sub('R', starter, 'active', 'annual', null, new Date(Date.now() - 40 * DAY));
  await sub('R', pro, 'trial', 'monthly', past, new Date(Date.now() - 35 * DAY));
});

afterAll(async () => {
  const q = (text: string, params: unknown[]) => pool.query(text, params).catch(() => undefined);
  const companies = Object.values(ids);
  await q('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [companies]);
  await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
  await q('DELETE FROM plans WHERE id = ANY($1::uuid[])', [plans]);
  await q('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
  await q('DELETE FROM users WHERE id = $1', [admin]);
});

const expected: Record<Letter, { plan: string | null; cycle: string | null }> = {
  X: { plan: null, cycle: null },
  L: { plan: planNames.pro, cycle: 'monthly' },
  A: { plan: planNames.pro, cycle: 'annual' },
  P: { plan: planNames.pro, cycle: 'monthly' },
  N: { plan: null, cycle: null },
  R: { plan: planNames.starter, cycle: 'annual' },
};

describe('admin companies show the plan feature gating uses (CURRENT_PLAN_ID_SQL)', () => {
  it('list: an expired or dateless trial has no plan; live trial, active and past_due have theirs', async () => {
    const list = await listCompanies({ search: tag, limit: 100 });
    const byLetter = Object.fromEntries(list.items.map((c) => [c.name.split(' ')[1], c.plan_name]));
    expect(byLetter).toEqual(Object.fromEntries(letters.map((l) => [l, expected[l].plan])));
    expect(list.total).toBe(6);
  });

  it('list: the plan filter matches the current plan only', async () => {
    const list = await listCompanies({ search: tag, limit: 100, plan: `cp-pro-${tag}` });
    expect(list.items.map((c) => c.name.split(' ')[1]).sort()).toEqual(['A', 'L', 'P']);
    expect(list.total).toBe(3);
  });

  it('detail: plan name and billing cycle come from the one current subscription', async () => {
    for (const l of letters) {
      const d = await getCompanyDetail(ids[l]);
      expect({ letter: l, plan: d?.plan_name ?? null, cycle: d?.billing_cycle ?? null })
        .toEqual({ letter: l, ...expected[l] });
    }
  });

  it('CSV export: the same plan per company, empty when there is none', async () => {
    const csv = await exportedPlans();
    expect(csv).toEqual(Object.fromEntries(letters.map((l) => [ids[l], expected[l].plan ?? ''])));
  });

  it('sorting by plan_name puts the companies with no plan last, both directions', async () => {
    for (const dir of ['asc', 'desc'] as const) {
      const list = await listCompanies({ search: tag, limit: 100, sort_by: 'plan_name', sort_dir: dir });
      const shown = list.items.map((c) => c.plan_name);
      const named = dir === 'asc'
        ? [planNames.pro, planNames.pro, planNames.pro, planNames.starter]
        : [planNames.starter, planNames.pro, planNames.pro, planNames.pro];
      expect({ dir, shown }).toEqual({ dir, shown: [...named, null, null] });
    }
  });
});
