/**
 * Deleting a company is a soft delete (companies.status='deleted') that the
 * admin platform can undo. Pins the three things that make it undoable and
 * safe: the admin list can still find a deleted company, activateCompany
 * restores it, and the billing run neither raises nor debits a charge for a
 * company while it is deleted. Paystack is mocked.
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
const { listCompanies, deleteCompany, activateCompany } = await import(
  '@/modules/admin/services/adminCompanyService'
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const companyName = `Restore fixture ${companyId}`;
const planId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const mandateId = crypto.randomUUID();
const userId = crypto.randomUUID();

const cronNow = new Date();
const periodEnd = new Date(cronNow.getTime() - 24 * 3600_000);
const periodStart = new Date(periodEnd.getTime() - 30 * 24 * 3600_000);

let cronLock: PoolClient;

async function listed(status?: string): Promise<string[]> {
  const result = await listCompanies({ search: companyName, status, limit: 100 });
  return result.items.map((c) => c.id);
}

async function charges(): Promise<Array<{ status: string; attempt_count: number }>> {
  const { rows } = await pool.query(
    'SELECT status, attempt_count FROM subscription_charges WHERE company_id=$1',
    [companyId],
  );
  return rows;
}

beforeAll(async () => {
  cronLock = await acquireCronLock(pool);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, companyName]);
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
  await activateCompany(companyId);
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
    await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
    await pool.query('DELETE FROM plans WHERE id=$1', [planId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await releaseCronLock(cronLock);
    await pool.end();
  }
});

describe('admin company list', () => {
  it('hides a deleted company by default and shows it under the Deleted filter', async () => {
    expect(await listed()).toEqual([companyId]);
    expect(await listed('deleted')).toEqual([]);

    await deleteCompany(companyId);

    expect(await listed()).toEqual([]);
    expect(await listed('active')).toEqual([]);
    expect(await listed('deleted')).toEqual([companyId]);
  });

  it('restores a deleted company to active', async () => {
    await deleteCompany(companyId);
    await activateCompany(companyId);

    expect(await listed()).toEqual([companyId]);
    expect(await listed('deleted')).toEqual([]);
    const { rows } = await pool.query('SELECT status FROM companies WHERE id=$1', [companyId]);
    expect(rows[0].status).toBe('active');
  });
});

describe('billing a deleted company', () => {
  it('raises no charge for a deleted company, and bills it again once restored', async () => {
    await deleteCompany(companyId);
    await generateDueCharges(cronNow);
    expect(await charges()).toEqual([]);

    await activateCompany(companyId);
    await generateDueCharges(cronNow);
    expect(await charges()).toEqual([{ status: 'queued', attempt_count: 0 }]);
  });

  it('does not debit a charge queued before the company was deleted', async () => {
    await generateDueCharges(cronNow);
    expect(await charges()).toEqual([{ status: 'queued', attempt_count: 0 }]);

    await deleteCompany(companyId);
    const ran = await runQueuedCharges(new Date());

    expect(ran.submitted).toBe(0);
    expect(chargeAuthorization).not.toHaveBeenCalled();
    expect(await charges()).toEqual([{ status: 'queued', attempt_count: 0 }]);
  });
});
