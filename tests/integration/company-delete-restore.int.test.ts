/**
 * Deleting a company is a soft delete the admin platform can undo
 * (companyLifecycleService). Pins: the admin list finds deleted companies
 * only under the Deleted filter; restore brings a company back (suspended if
 * it was suspended); and billing follows the "fresh start" rule — delete voids
 * unsent charges for periods not yet granted, keeps a debt for a granted
 * period without debiting it while deleted, and restore bills one new period
 * from today instead of every cycle missed. Paystack is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { acquireCronLock, releaseCronLock } from './subscription-cron.lock';

assertDisposable();

const chargeAuthorization = vi.fn(async () => {
  throw new Error('Paystack must not be reached in this test');
});
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
}));

const { generateDueCharges, runQueuedCharges } = await import(
  '@/modules/billing/services/subscriptionBillingService'
);
const { listCompanies, suspendCompany } = await import('@/modules/admin/services/adminCompanyService');
const { deleteCompany, restoreCompany } = await import('@/modules/admin/services/companyLifecycleService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const nullStatusId = crypto.randomUUID();
const tag = `Restore fixture ${companyId}`;
const planId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const mandateId = crypto.randomUUID();
const userId = crypto.randomUUID();

const DAY = 24 * 3600_000;
const cronNow = new Date();
const today = cronNow.toISOString().slice(0, 10);
const periodEnd = new Date(cronNow.getTime() - DAY);
const periodStart = new Date(periodEnd.getTime() - 30 * DAY);

let cronLock: PoolClient;

const listed = async (status?: string): Promise<string[]> =>
  (await listCompanies({ search: tag, status, limit: 100 })).items.map((c) => c.id).sort();

async function charges(): Promise<Array<{ status: string; failure_reason: string | null; period_start: string }>> {
  const { rows } = await pool.query(
    `SELECT status, failure_reason, period_start::text AS period_start
     FROM subscription_charges WHERE company_id=$1 ORDER BY period_start`,
    [companyId],
  );
  return rows;
}
const companyStatus = async (): Promise<string> =>
  (await pool.query('SELECT status FROM companies WHERE id=$1', [companyId])).rows[0].status;

beforeAll(async () => {
  cronLock = await acquireCronLock(pool);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [companyId, tag, nullStatusId, `${tag} null`]);
  await pool.query('UPDATE companies SET status=NULL WHERE id=$1', [nullStatusId]);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@restore.test.local`],
  );
  await pool.query(
    'INSERT INTO plans(id,code,name,monthly_price_cents,annual_price_cents) VALUES($1,$2,$3,$4,$5)',
    [planId, `restore-${planId.slice(0, 8)}`, 'Restore plan', 49900, 499000],
  );
  await pool.query(
    `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway,
       paystack_authorization_code,paystack_customer_code,authorised_at)
     VALUES($1,$2,$3,$4,'active','paystack','AUTH_restore','CUS_restore',now())`,
    [mandateId, companyId, 10_000_00, userId],
  );
});

beforeEach(async () => {
  await pool.query(
    "UPDATE companies SET status='active', suspended_at=NULL, suspended_reason=NULL WHERE id=$1",
    [companyId],
  );
  await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [companyId]);
  await pool.query(
    `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
       current_period_start,current_period_end,cancel_at_period_end,discount_percent)
     VALUES($1,$2,$3,'active','monthly',$4,$5,false,0)`,
    [subscriptionId, companyId, planId, periodStart, periodEnd],
  );
  chargeAuthorization.mockClear();
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscription_mandates WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM companies WHERE id IN ($1,$2)', [companyId, nullStatusId]);
    await pool.query('DELETE FROM plans WHERE id=$1', [planId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await releaseCronLock(cronLock);
    await pool.end();
  }
});

describe('admin company list', () => {
  it('shows a deleted company only under the Deleted filter; a NULL-status company counts as active', async () => {
    const both = [companyId, nullStatusId].sort();
    expect(await listed()).toEqual(both);
    expect(await listed('active')).toEqual(both);
    expect(await listed('deleted')).toEqual([]);

    await deleteCompany(companyId);

    expect(await listed()).toEqual([nullStatusId]);
    expect(await listed('active')).toEqual([nullStatusId]);
    expect(await listed('deleted')).toEqual([companyId]);
  });
});

describe('restoreCompany', () => {
  it('brings a deleted company back to active', async () => {
    await deleteCompany(companyId);
    expect(await restoreCompany(companyId)).toBe(true);
    expect(await companyStatus()).toBe('active');
    expect(await listed('deleted')).toEqual([]);
  });

  it('brings a company that was suspended before the delete back suspended', async () => {
    await suspendCompany(companyId, 'unpaid');
    await deleteCompany(companyId);
    expect(await restoreCompany(companyId)).toBe(true);
    expect(await companyStatus()).toBe('suspended');
  });

  it('refuses a company that is not deleted, and one that does not exist', async () => {
    expect(await restoreCompany(companyId)).toBe(false);
    expect(await restoreCompany(crypto.randomUUID())).toBe(false);
    expect(await companyStatus()).toBe('active');
  });
});

describe('billing across delete and restore', () => {
  it('raises no charge for a deleted company', async () => {
    await deleteCompany(companyId);
    await generateDueCharges(cronNow);
    expect(await charges()).toEqual([]);
  });

  it('voids an unsent charge for a period not yet granted, so restore never debits it', async () => {
    await generateDueCharges(cronNow);
    expect((await charges()).map((c) => c.status)).toEqual(['queued']);

    await deleteCompany(companyId);
    expect(await charges()).toEqual([
      expect.objectContaining({ status: 'cancelled', failure_reason: 'company_deleted' }),
    ]);

    await restoreCompany(companyId);
    const ran = await runQueuedCharges(new Date());
    expect(ran.submitted).toBe(0);
    expect(chargeAuthorization).not.toHaveBeenCalled();
  });

  it('keeps a debt for a granted period, and does not debit it while deleted', async () => {
    await generateDueCharges(cronNow);
    // The period was granted (past_due) before payment: the charge is a debt.
    await pool.query(
      "UPDATE subscriptions SET status='past_due', current_period_end=$2 WHERE id=$1",
      [subscriptionId, new Date(cronNow.getTime() + 20 * DAY)],
    );

    await deleteCompany(companyId);
    expect((await charges()).map((c) => c.status)).toEqual(['queued']);

    const ran = await runQueuedCharges(new Date());
    expect(ran.submitted).toBe(0);
    expect(chargeAuthorization).not.toHaveBeenCalled();
    expect((await charges()).map((c) => c.status)).toEqual(['queued']);
  });

  it('restore after a long delete bills one period from today, not every missed cycle', async () => {
    await pool.query(
      'UPDATE subscriptions SET current_period_start=$2, current_period_end=$3 WHERE id=$1',
      [subscriptionId, new Date(cronNow.getTime() - 120 * DAY), new Date(cronNow.getTime() - 90 * DAY)],
    );
    await deleteCompany(companyId);
    await restoreCompany(companyId);

    await generateDueCharges(new Date());
    const raised = await charges();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ status: 'queued', period_start: today });
  });

  it('restore leaves a subscription whose period is still running alone', async () => {
    const running = new Date(cronNow.getTime() + 10 * DAY);
    await pool.query('UPDATE subscriptions SET current_period_end=$2 WHERE id=$1', [subscriptionId, running]);
    await deleteCompany(companyId);
    await restoreCompany(companyId);

    const { rows } = await pool.query('SELECT current_period_end FROM subscriptions WHERE id=$1', [subscriptionId]);
    expect(new Date(rows[0].current_period_end).toISOString()).toBe(running.toISOString());
  });
});
