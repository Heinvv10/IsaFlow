/**
 * Fixture for the admin-trials-*.int.test.ts suites: a super_admin who calls
 * the real routes, the admin pool logged in as platform_admin itself (the
 * harness's default URL is a superuser, which would prove nothing about the
 * grants convert needs), the plans the trial pages deal in, and companies in
 * each trial shape.
 *
 * Disposable schema fixture only (assertDisposable, via the s07 helpers).
 */
import { vi } from 'vitest';
import { callRoute, pool } from './s07-users-privilege-columns.helpers';

export { pool };
export const admin = crypto.randomUUID();
export const tag = crypto.randomUUID().slice(0, 8);

const plansMade: string[] = [];
const companiesMade: string[] = [];

export interface TrialPlans { paid: string; paid2: string; trial: string; payg: string; archived: string }

export async function startAdmin(): Promise<void> {
  const password = crypto.randomUUID();
  await pool.query(`ALTER ROLE platform_admin LOGIN PASSWORD '${password}'`);
  const url = new URL(process.env.DATABASE_URL!);
  url.username = 'platform_admin';
  url.password = password;
  // The admin pool is built on the first admin route call: point it at the role first.
  vi.stubEnv('PLATFORM_ADMIN_DATABASE_URL', url.toString());
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`,
    [admin, `${admin}@test.local`]);
  await pool.query(`DELETE FROM rate_limit_counters WHERE key LIKE '%127.0.0.79%'`);
}

export async function stopAdmin(): Promise<void> {
  const q = (text: string, params: unknown[] = []) => pool.query(text, params).catch(() => undefined);
  await q('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
  await q('DELETE FROM subscription_mandates WHERE company_id = ANY($1::uuid[])', [companiesMade]);
  await q('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [companiesMade]);
  await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companiesMade]);
  await q('DELETE FROM plans WHERE id = ANY($1::uuid[])', [plansMade]);
  await q('DELETE FROM users WHERE id = $1', [admin]);
  await q(`DELETE FROM rate_limit_counters WHERE key LIKE '%127.0.0.79%'`);
  await q('ALTER ROLE platform_admin NOLOGIN PASSWORD NULL');
  vi.unstubAllEnvs();
}

export const asAdmin = (route: unknown, method: string, opts: { query?: Record<string, string>; body?: unknown } = {}) =>
  callRoute(route, { sub: admin, method, ...opts });

async function plan(code: string, name: string, monthly: number, active = true): Promise<string> {
  const made = await pool.query(`INSERT INTO plans (code, name, monthly_price_cents, annual_price_cents, is_active)
    VALUES ($1, $2, $3, $3 * 10, $4) ON CONFLICT (code) DO NOTHING RETURNING id`, [code, name, monthly, active]);
  if (made.rows[0]) { plansMade.push(made.rows[0].id as string); return made.rows[0].id as string; }
  return (await pool.query('SELECT id FROM plans WHERE code = $1', [code])).rows[0]!.id as string;
}

/** The internal `trial` and `payg` plans (reused when the fixture has them), two paid plans and an archived one. */
export async function seedPlans(): Promise<TrialPlans> {
  return {
    paid: await plan(`wp2-pro-${tag}`, 'WP2 Pro', 59900),
    paid2: await plan(`wp2-biz-${tag}`, 'WP2 Business', 99900),
    trial: await plan('trial', 'Free Trial', 0),
    payg: await plan('payg', 'Pay as you go', 0),
    archived: await plan(`wp2-old-${tag}`, 'WP2 Archived', 19900, false),
  };
}

export interface CompanyShape {
  name: string;
  /** Days from now the trial ends (negative: ended that many days ago); null: no trial_ends_at. */
  endsInDays: number | null;
  status?: string;
  sub?: SubShape;
  /** More subscriptions for the same company (oldest first; `sub` is created before them). */
  moreSubs?: SubShape[];
}

export interface SubShape { plan: string; status: string; periodEndDays?: number | null; createdDaysAgo?: number }

export async function makeCompany(shape: CompanyShape): Promise<string> {
  const id = crypto.randomUUID();
  companiesMade.push(id);
  await pool.query(
    `INSERT INTO companies (id, name, status, trial_ends_at)
     VALUES ($1, $2, $3, CASE WHEN $4::numeric IS NULL THEN NULL ELSE NOW() + $4::numeric * interval '1 day' END)`,
    [id, `${shape.name} ${tag}`, shape.status ?? 'active', shape.endsInDays]);
  for (const sub of [shape.sub, ...(shape.moreSubs ?? [])]) {
    if (!sub) continue;
    await pool.query(
      `INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle, current_period_start, current_period_end, created_at)
       VALUES ($1, $2, $3, 'monthly', NOW() - interval '30 days',
         CASE WHEN $4::numeric IS NULL THEN NULL ELSE NOW() + $4::numeric * interval '1 day' END,
         NOW() - $5::numeric * interval '1 day')`,
      [id, sub.plan, sub.status, sub.periodEndDays ?? shape.endsInDays, sub.createdDaysAgo ?? 0]);
  }
  return id;
}

export async function subsOf(companyId: string) {
  return (await pool.query(
    `SELECT id, plan_id, status, billing_cycle, current_period_start, current_period_end, cancel_at_period_end, cancelled_at
     FROM subscriptions WHERE company_id = $1 ORDER BY created_at`, [companyId])).rows;
}

export async function companyRow(companyId: string) {
  return (await pool.query(
    'SELECT status, plan_id, trial_ends_at FROM companies WHERE id = $1', [companyId])).rows[0] as
    { status: string; plan_id: string | null; trial_ends_at: Date | null };
}

export async function auditCount(action: string, targetId: string): Promise<number> {
  return (await pool.query('SELECT 1 FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 AND target_id = $3',
    [admin, action, targetId])).rowCount ?? 0;
}

export const nowSkewSeconds = (d: Date | string, expectedFromNowSeconds: number): number =>
  Math.abs((new Date(d).getTime() - Date.now()) / 1000 - expectedFromNowSeconds);

export async function addMandate(companyId: string, status = 'active'): Promise<void> {
  await pool.query(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway) VALUES ($1, 100000, $2, 'paystack')`,
    [companyId, status]);
}

/** An admin audit row of `action` on `targetId`, `daysAgo` days old. */
export async function addAudit(action: string, targetType: string, targetId: string, daysAgo: number): Promise<void> {
  await pool.query(`INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, created_at)
    VALUES ($1, $2, $3, $4, NOW() - $5::numeric * interval '1 day')`, [admin, action, targetType, targetId, daysAgo]);
}
