/**
 * Fixture for admin-metrics-*.int.test.ts: plans, companies in every revenue
 * shape the one-MRR definition (goal §2a) has to sort, and a super admin.
 * Disposable schema fixture only (assertDisposable, via the s07 helpers).
 *
 * Revenue shapes (prices in cents; A..H are the suite's companies):
 *   A  active, Pro monthly 59900 at 50% discount          -> MRR 29950
 *   B  active, Starter annual 299000                       -> MRR 24916.67
 *   C  active, two Starter annual subscriptions            -> MRR 49833.33
 *   D  trial subscription on Starter monthly, trial ahead  -> 0 (trials never in MRR)
 *   E  DELETED company, active Pro monthly                 -> 0
 *   F  SUSPENDED company, active Starter monthly           -> 0
 *   G  is_demo company, active Pro monthly                 -> 0
 *   H  active on a R0 plan (PAYG-like)                     -> 0, not a paying company
 *   K  signed up last month (SAST), active on the R0 plan  -> cohort M0
 * The suite's MRR units total 3 x 29_900_000 + 35_940_000 = 125_640_000, a
 * multiple of 1200, so its MRR delta (104 700) and ARR delta (1 256 400) are
 * exact whatever other suites left in the database.
 */
import { callRoute, pool } from './s07-users-privilege-columns.helpers';

export { pool, callRoute };
export const tag = crypto.randomUUID().slice(0, 8);
export const admin = crypto.randomUUID();
export const signedIn = crypto.randomUUID();

const DAY = 86_400_000;
const plans: string[] = [];
const companies: string[] = [];
const flags: string[] = [];

export const ids: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'K', string> = {
  A: crypto.randomUUID(), B: crypto.randomUUID(), C: crypto.randomUUID(), D: crypto.randomUUID(),
  E: crypto.randomUUID(), F: crypto.randomUUID(), G: crypto.randomUUID(), H: crypto.randomUUID(),
  K: crypto.randomUUID(),
};
export const planNames = { pro: `WP8 Pro ${tag}`, starter: `WP8 Starter ${tag}`, free: `WP8 Free ${tag}` };
export const flagNames = { planned: `WP8 planned ${tag}`, global: `WP8 global ${tag}` };

async function plan(name: string, monthly: number, annual: number): Promise<string> {
  const r = await pool.query(
    `INSERT INTO plans (code, name, monthly_price_cents, annual_price_cents) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`wp8-${name.split(' ')[1]!.toLowerCase()}-${tag}`, name, monthly, annual]);
  plans.push(r.rows[0].id as string);
  return r.rows[0].id as string;
}

async function company(id: string, letter: string, opts: { status?: string; isDemo?: boolean; createdAt?: Date; trialEndsAt?: Date } = {}) {
  await pool.query(
    `INSERT INTO companies (id, name, status, is_demo, created_at, trial_ends_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, `WP8 ${letter} ${tag}`, opts.status ?? 'active', opts.isDemo ?? false, opts.createdAt ?? new Date(), opts.trialEndsAt ?? null]);
  companies.push(id);
}

async function sub(companyId: string, planId: string, cycle: string, status = 'active', discount = 0, createdAt = new Date()) {
  await pool.query(
    `INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle, discount_percent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`, [companyId, planId, status, cycle, discount, createdAt]);
}

/** The first instant of the previous SAST month, plus two days. */
export function lastMonthSignup(now = new Date()): Date {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  return new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth() - 1, 3) - 2 * 3_600_000);
}

export async function seed(): Promise<void> {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  const pro = await plan(planNames.pro, 59900, 599000);
  const starter = await plan(planNames.starter, 29900, 299000);
  const free = await plan(planNames.free, 0, 0);
  await company(ids.A, 'A'); await sub(ids.A, pro, 'monthly', 'active', 50);
  await company(ids.B, 'B'); await sub(ids.B, starter, 'annual');
  await company(ids.C, 'C'); await sub(ids.C, starter, 'annual'); await sub(ids.C, starter, 'annual');
  await company(ids.D, 'D', { trialEndsAt: new Date(Date.now() + 10 * DAY) }); await sub(ids.D, starter, 'monthly', 'trial');
  await company(ids.E, 'E', { status: 'deleted' }); await sub(ids.E, pro, 'monthly');
  await company(ids.F, 'F', { status: 'suspended' }); await sub(ids.F, starter, 'monthly');
  await company(ids.G, 'G', { isDemo: true }); await sub(ids.G, pro, 'monthly');
  await company(ids.H, 'H'); await sub(ids.H, free, 'monthly');
  const signup = lastMonthSignup();
  await company(ids.K, 'K', { createdAt: signup }); await sub(ids.K, free, 'monthly', 'active', 0, signup);

  const planned = await pool.query(`INSERT INTO feature_flags (code, name, is_global) VALUES ($1, $2, false) RETURNING id`,
    [`wp8_planned_${tag}`, flagNames.planned]);
  const global = await pool.query(`INSERT INTO feature_flags (code, name, is_global) VALUES ($1, $2, true) RETURNING id`,
    [`wp8_global_${tag}`, flagNames.global]);
  flags.push(planned.rows[0].id as string, global.rows[0].id as string);
  // Pro grants the planned flag (A has it through the plan; E is deleted); B has it by override.
  await pool.query('INSERT INTO plan_features (plan_id, feature_id) VALUES ($1, $2)', [pro, flags[0]]);
  await pool.query(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by) VALUES ($1, $2, true, $3)`,
    [ids.B, flags[0], admin]);
}

/** A member of company A who signed in an hour ago (users.last_login). */
export async function seedSignedInUser(): Promise<void> {
  await pool.query(`INSERT INTO users (id, email, first_name, last_name, role, is_active, last_login)
    VALUES ($1, $2, 'Wp8', $3, 'viewer', true, NOW() - INTERVAL '1 hour')`, [signedIn, `${signedIn}@test.local`, tag]);
}

export async function cleanup(): Promise<void> {
  const q = (text: string, params: unknown[]) => pool.query(text, params).catch(() => undefined);
  await q('DELETE FROM company_feature_overrides WHERE feature_id = ANY($1::uuid[])', [flags]);
  await q('DELETE FROM plan_features WHERE feature_id = ANY($1::uuid[])', [flags]);
  await q('DELETE FROM feature_flags WHERE id = ANY($1::uuid[])', [flags]);
  await q('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [companies]);
  await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
  await q('DELETE FROM plans WHERE id = ANY($1::uuid[])', [plans]);
  await q('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
  await q('DELETE FROM users WHERE id = ANY($1::text[])', [[admin, signedIn]]);
}

export const ok = <T>(r: { status: number; body: unknown }): T => {
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return (r.body as { data: T }).data;
};
