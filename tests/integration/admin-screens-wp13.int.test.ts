/**
 * Admin screens (WP13, admin audit 2026-11-14) — the server half of four screen defects:
 *  - 4.1  Companies sorts by Plan and by Last Active (the list API threw "Invalid sort column").
 *  - 4.7  A user's Audit tab asks for entity_type=user&entity_id=<id>: only entries about that user come back.
 *  - 4.15 Dashboard Recent Activity names the company an admin action was about.
 *  - 4.17 Company edit can clear a field: an explicit null (or a free-text '') clears it, an absent key keeps it.
 *  - Review: entity_type applies to admin rows; a non-uuid target id is no cast error; sort_by=constructor is refused.
 * Runs on the disposable fixture database only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const { listCompanies, updateCompany, getCompanyDetail } = await import('@/modules/admin/services/adminCompanyService');
const { getUnifiedAuditLog } = await import('@/modules/admin/services/auditQueryService');
const { getDashboardStats } = await import('@/modules/admin/services/adminDashboardService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const run = crypto.randomUUID().slice(0, 8);
const tag = `WP13Sort ${run}`;
const planA = crypto.randomUUID();
const planZ = crypto.randomUUID();
const [cZ, cA, cNone] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const [userA, userB, admin] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const auditIds: string[] = [];

beforeAll(async () => {
  await pool.query(
    `INSERT INTO plans (id, code, name, monthly_price_cents, annual_price_cents, is_active)
     VALUES ($1, $2, $3, 10000, 100000, true), ($4, $5, $6, 20000, 200000, true)`,
    [planA, `wp13-a-${run}`, `AAA plan ${run}`, planZ, `wp13-z-${run}`, `ZZZ plan ${run}`]);
  await pool.query(
    `INSERT INTO companies (id, name, phone, city, updated_at) VALUES
       ($1, $2, '011 000 0001', 'Pretoria', NOW() - INTERVAL '1 day'),
       ($3, $4, NULL, NULL, NOW() - INTERVAL '3 days'),
       ($5, $6, NULL, NULL, NOW() - INTERVAL '2 days')`,
    [cZ, `${tag} one`, cA, `${tag} two`, cNone, `${tag} three`]);
  // The companies' triggers may touch updated_at on insert: pin the order afterwards.
  await pool.query(`UPDATE companies SET updated_at = NOW() - make_interval(days => $2) WHERE id = $1`, [cZ, 1]);
  await pool.query(`UPDATE companies SET updated_at = NOW() - make_interval(days => $2) WHERE id = $1`, [cA, 3]);
  await pool.query(`UPDATE companies SET updated_at = NOW() - make_interval(days => $2) WHERE id = $1`, [cNone, 2]);
  await pool.query(
    `INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle) VALUES ($1, $2, 'active', 'monthly'), ($3, $4, 'active', 'monthly')`,
    [cZ, planZ, cA, planA]);
  await pool.query(
    `INSERT INTO users (id, email, role, is_active, first_name, last_name, last_login) VALUES
       ($1, $2, 'viewer', true, 'Ann', 'Wp13', NOW() - INTERVAL '1 day'),
       ($3, $4, 'viewer', true, 'Ben', 'Wp13', NOW() - INTERVAL '3 days'),
       ($5, $6, 'super_admin', true, 'Ada', 'Admin', NULL)`,
    [userA, `wp13-a-${run}@test.local`, userB, `wp13-b-${run}@test.local`, admin, `wp13-admin-${run}@test.local`]);
  // Last Active is whatever the list reports (updated_at today, last sign-in after WP3): link users in the same order.
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $4, 'admin')`,
    [cZ, userA, cA, userB]);
  const future = (minutes: number) => `NOW() + INTERVAL '${minutes} minutes'`;
  const rows = await pool.query<{ id: string }>(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details, created_at) VALUES
       ($1, 'user.suspend',      'user',         $2, '{}'::jsonb, ${future(50)}),
       ($1, 'user.update',       'user',         $3, '{}'::jsonb, ${future(51)}),
       ($1, 'company.suspend',   'company',      $4, '{}'::jsonb, ${future(52)}),
       ($1, 'subscription.create','subscription', $5, jsonb_build_object('company_id', $6::text), ${future(53)}),
       ($1, 'company.legacy',    'company',      'legacy-123', '{"company_id": "not-a-uuid"}'::jsonb, ${future(54)}),
       ($1, 'feature.override',  'company',      $2, '{}'::jsonb, ${future(55)})
     RETURNING id::text`,
    [admin, userA, userB, cZ, crypto.randomUUID(), cA]);
  auditIds.push(...rows.rows.map((r) => r.id));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE id = ANY($1::uuid[])', [auditIds]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[cZ, cA, cNone]]);
    await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [[cZ, cA, cNone]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[cZ, cA, cNone]]);
    await pool.query('DELETE FROM plans WHERE id = ANY($1::uuid[])', [[planA, planZ]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[userA, userB, admin]]);
  } finally {
    await pool.end();
  }
});

describe('4.1 Companies list sorts on Plan and Last Active', () => {
  it('sorts by plan name both ways, companies without a plan last', async () => {
    const asc = await listCompanies({ search: tag, sort_by: 'plan_name', sort_dir: 'asc' });
    expect(asc.items.map((c) => c.id)).toEqual([cA, cZ, cNone]);
    const desc = await listCompanies({ search: tag, sort_by: 'plan_name', sort_dir: 'desc' });
    expect(desc.items.map((c) => c.id)).toEqual([cZ, cA, cNone]);
  });

  it('sorts by last active both ways, never-active last', async () => {
    for (const dir of ['asc', 'desc'] as const) {
      const res = await listCompanies({ search: tag, sort_by: 'last_active', sort_dir: dir });
      expect(res.total).toBe(3);
      const seen = res.items.map((c) => c.last_active);
      const dated = seen.filter((v): v is string => v != null).map((v) => Date.parse(v));
      // Nulls (if the definition yields any) come after every dated row.
      expect(seen.slice(0, dated.length).every((v) => v != null)).toBe(true);
      const sorted = [...dated].sort((a, b) => (dir === 'asc' ? a - b : b - a));
      expect(dated).toEqual(sorted);
      expect(new Set(dated).size).toBeGreaterThan(1);
    }
  });
});

describe('4.7 audit log scoped to one entity', () => {
  it('entity_type=user&entity_id=A returns only entries about user A', async () => {
    const res = await getUnifiedAuditLog({ entity_type: 'user', entity_id: userA, limit: 20 });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((e) => e.entity_id === userA)).toBe(true);
    expect(res.items.some((e) => e.action === 'user.suspend')).toBe(true);
    expect(res.total).toBe(res.items.length);
  });

  it('entity_type applies to admin rows too: a company-typed row on the same id is left out (review L2)', async () => {
    const res = await getUnifiedAuditLog({ entity_type: 'user', entity_id: userA, source: 'admin', limit: 20 });
    expect(res.items.map((e) => e.action)).toEqual(['user.suspend']);
    expect(res.total).toBe(1);
  });
});

describe('4.15 Recent Activity names the company', () => {
  it('a company action shows that company; a subscription action shows the company in its details', async () => {
    const stats = await getDashboardStats();
    const byDesc = (d: string) => stats.recent_activity.find((r) => r.description === d);
    expect(byDesc('company.suspend company')?.company_name).toBe(`${tag} one`);
    expect(byDesc('subscription.create subscription')?.company_name).toBe(`${tag} two`);
    expect(byDesc('user.update user')?.company_name ?? null).toBeNull();
    // A non-uuid target or details id is shown without a company, not a cast error (review L4).
    expect(byDesc('company.legacy company')?.company_name ?? null).toBeNull();
  });
});

describe('4.17 company edit can clear a field', () => {
  it('null clears the column, an absent key keeps it', async () => {
    await updateCompany(cZ, { phone: null } as unknown as Parameters<typeof updateCompany>[1]);
    const after = await getCompanyDetail(cZ);
    expect(after?.phone ?? null).toBeNull();
    expect(after?.city).toBe('Pretoria');
  });

  it("'' clears a free-text field too", async () => {
    await updateCompany(cZ, { city: '' } as unknown as Parameters<typeof updateCompany>[1]);
    expect((await getCompanyDetail(cZ))?.city ?? null).toBeNull();
  });
});

describe('sort allowlist (review L3)', () => {
  it('an Object.prototype name is refused before any SQL', async () => {
    await expect(listCompanies({ search: tag, sort_by: 'constructor' })).rejects.toThrow('Invalid sort column: constructor');
  });
});
