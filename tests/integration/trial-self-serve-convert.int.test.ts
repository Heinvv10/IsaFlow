/**
 * Self-serve upgrade from trial: convertOwnTrial on a real migration_admin login (MIGRATION_ADMIN_DATABASE_URL
 * pointed at the role itself, not the harness superuser), so the grants it relies on are proven: locking and
 * updating companies, writing subscriptions, reading the mandate's authorization code and inserting audit_log,
 * all in one transaction. Also: no mandate refuses with nothing written, a second call is a no-op with no
 * second audit row, a company that never had a trial is refused, and a mandate authorised for a cheaper plan
 * cannot convert to a dearer one.
 *
 * Disposable schema fixture only (assertDisposable, via the admin-trials helpers).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { urlAsRole } from './s07-users-privilege-columns.helpers';
import { companyRow, makeCompany, pool, seedPlans, stopAdmin, subsOf, type TrialPlans } from './admin-trials.helpers';
import { convertOwnTrial } from '@/modules/billing/services/selfServeUpgrade';
import { TrialConvertError } from '@/modules/admin/services/trialErrors';

let plans: TrialPlans;
const owner = crypto.randomUUID();

beforeAll(async () => {
  // The billing admin pool is built on first use: point it at migration_admin first.
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', urlAsRole('migration_admin'));
  plans = await seedPlans();
  // audit_log.user_id references users: the owner is a real users row, as it is for a signed-in request.
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [owner, `${owner}@test.local`]);
}, 60000);

afterAll(async () => {
  await stopAdmin();
  await pool.end();
}, 60000);

/** A chargeable mandate authorised for a plan priced `ceilingCents` (start.ts sets the ceiling to the plan's price). */
async function chargeableMandate(companyId: string, ceilingCents = 59900): Promise<void> {
  await pool.query(
    `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, paystack_authorization_code)
     VALUES ($1, $2, 'active', 'paystack', $3)`, [companyId, ceilingCents, `AUTH_${crypto.randomUUID().slice(0, 8)}`]);
}

const auditRows = async (companyId: string) => (await pool.query(
  `SELECT user_id, action, entity_type, changes FROM audit_log
    WHERE company_id = $1 AND changes->'metadata'->>'change' = 'trial_self_serve_convert'`, [companyId])).rows;

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof TrialConvertError ? e.code : String(e)));

describe('self-serve convert on migration_admin', () => {
  it('converts a trial with a chargeable mandate, audits it once, and a retry is a no-op', async () => {
    const id = await makeCompany({ name: 'Self-serve ok', endsInDays: 9, status: 'trial',
      sub: { plan: plans.trial, status: 'trial' } });
    await chargeableMandate(id);

    const first = await convertOwnTrial({ companyId: id, userId: owner, planId: plans.paid });
    expect(first.alreadyConverted).toBe(false);
    expect(first.hasActiveMandate).toBe(true);

    const subs = await subsOf(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ plan_id: plans.paid, status: 'active', billing_cycle: 'monthly', cancel_at_period_end: false });
    expect(new Date(subs[0].current_period_end).getTime()).toBeGreaterThan(Date.now());
    expect(await companyRow(id)).toMatchObject({ status: 'active', plan_id: plans.paid });
    const audits = await auditRows(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ user_id: owner, action: 'update', entity_type: 'company' });

    const again = await convertOwnTrial({ companyId: id, userId: owner, planId: plans.paid });
    expect(again).toMatchObject({ alreadyConverted: true, subscriptionId: first.subscriptionId });
    expect(await auditRows(id)).toHaveLength(1);
    expect(await refusal(convertOwnTrial({ companyId: id, userId: owner, planId: plans.paid2 }))).toBe('already_paid');
  }, 30000);

  it('refuses without a chargeable mandate and writes nothing', async () => {
    const id = await makeCompany({ name: 'Self-serve no mandate', endsInDays: 9, status: 'trial',
      sub: { plan: plans.trial, status: 'trial' } });
    await pool.query(`INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway) VALUES ($1, 100000, 'pending', 'paystack')`, [id]);

    expect(await refusal(convertOwnTrial({ companyId: id, userId: owner, planId: plans.paid }))).toBe('mandate_required');
    expect((await subsOf(id))[0]).toMatchObject({ plan_id: plans.trial, status: 'trial' });
    expect(await companyRow(id)).toMatchObject({ status: 'trial' });
    expect(await auditRows(id)).toHaveLength(0);
  }, 30000);

  it('authorise cheap, convert dear: refused with nothing written', async () => {
    const id = await makeCompany({ name: 'Self-serve cheap then dear', endsInDays: 9, status: 'trial',
      sub: { plan: plans.trial, status: 'trial' } });
    await chargeableMandate(id, 59900); // authorised WP2 Pro (R599)
    expect(await refusal(convertOwnTrial({ companyId: id, userId: owner, planId: plans.paid2 }))).toBe('mandate_plan_mismatch');
    expect((await subsOf(id))[0]).toMatchObject({ plan_id: plans.trial, status: 'trial' });
    expect(await companyRow(id)).toMatchObject({ status: 'trial' });
    expect(await auditRows(id)).toHaveLength(0);
    // The plan the owner authorised still converts.
    expect((await convertOwnTrial({ companyId: id, userId: owner, planId: plans.paid })).alreadyConverted).toBe(false);
  }, 30000);

  it('refuses a company that never had a trial', async () => {
    const id = await makeCompany({ name: 'Self-serve never trial', endsInDays: null });
    await chargeableMandate(id);
    expect(await refusal(convertOwnTrial({ companyId: id, userId: owner, planId: plans.paid }))).toBe('not_on_trial');
    expect(await subsOf(id)).toHaveLength(0);
  }, 30000);
});
