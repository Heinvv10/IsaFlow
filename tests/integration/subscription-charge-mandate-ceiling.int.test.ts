/**
 * The charge run never debits above the mandate's ceiling (subscription_mandates.max_amount_cents), on real
 * Postgres: selectChargeableCharges compares the bigint amount with the ceiling in SQL and runQueuedCharges
 * sends only a charge known to be at or below it. An above-ceiling charge is not claimed (attempt_count stays
 * 0, status stays queued) and is ordered after chargeable ones, so it cannot fill the batch. A charge pointing
 * at another company's mandate is never selected. Paystack is mocked; no network call is made.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { acquireCronLock, releaseCronLock } from './subscription-cron.lock';

assertDisposable();

const chargeAuthorization = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  chargeAuthorization: (...args: unknown[]) => chargeAuthorization(...args),
  verifyTransaction: vi.fn(),
  initializeTransaction: vi.fn(async () => { throw new Error('not reached in this suite'); }),
}));

const { runQueuedCharges } = await import('@/modules/billing/services/subscriptionBillingService');
const { selectChargeableCharges } = await import('@/modules/billing/services/subscriptionChargePlan');
const { startMandateCheckout } = await import('@/modules/billing/services/mandateCheckout');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const planId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const otherSubscriptionId = crypto.randomUUID();
const mandateId = crypto.randomUUID();
const otherMandateId = crypto.randomUUID();
const userId = crypto.randomUUID();
/** Paying (annual, 10% off) with no mandate yet: a new mandate's ceiling must cover its charge. */
const unmandatedCompanyId = crypto.randomUUID();
const CEILING = 59900;

let cronLock: PoolClient;

beforeAll(async () => {
  cronLock = await acquireCronLock(pool);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [companyId, 'Ceiling fixture', otherCompanyId, 'Ceiling other tenant']);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [unmandatedCompanyId, 'Ceiling no mandate']);
  await pool.query("INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@ceiling.test.local`]);
  await pool.query('INSERT INTO plans(id,code,name,monthly_price_cents,annual_price_cents) VALUES($1,$2,$3,$4,$5)',
    [planId, `ceiling-${planId.slice(0, 8)}`, 'Ceiling plan', CEILING, CEILING * 10]);
  for (const [id, co, code] of [[mandateId, companyId, 'AUTH_ceil'], [otherMandateId, otherCompanyId, 'AUTH_ceil_other']]) {
    await pool.query(
      `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway,
         paystack_authorization_code,paystack_customer_code,authorised_at)
       VALUES($1,$2,$3,$4,'active','paystack',$5,'CUS_ceil',now())`, [id, co, CEILING, userId, code]);
  }
  for (const [id, co] of [[subscriptionId, companyId], [otherSubscriptionId, otherCompanyId]]) {
    await pool.query(
      `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
         current_period_start,current_period_end,cancel_at_period_end,discount_percent)
       VALUES($1,$2,$3,'active','monthly',now() - interval '1 month',now() + interval '1 day',false,0)`, [id, co, planId]);
  }
  await pool.query(
    `INSERT INTO subscriptions(company_id,plan_id,status,billing_cycle,
       current_period_start,current_period_end,cancel_at_period_end,discount_percent)
     VALUES($1,$2,'active','annual',now() - interval '1 month',now() + interval '11 months',false,10)`,
    [unmandatedCompanyId, planId]);
}, 60000);

beforeEach(async () => {
  chargeAuthorization.mockReset();
  await pool.query('DELETE FROM paystack_payment_requests WHERE company_id = ANY($1::uuid[])', [[companyId, otherCompanyId]]);
  await pool.query('DELETE FROM subscription_charges WHERE company_id = ANY($1::uuid[])', [[companyId, otherCompanyId]]);
});

afterAll(async () => {
  try {
    const both = [companyId, otherCompanyId, unmandatedCompanyId];
    await pool.query('DELETE FROM paystack_payment_requests WHERE company_id = ANY($1::uuid[])', [both]);
    await pool.query('DELETE FROM subscription_charges WHERE company_id = ANY($1::uuid[])', [both]);
    await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [both]);
    await pool.query('DELETE FROM subscription_mandates WHERE company_id = ANY($1::uuid[])', [both]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [both]);
    await pool.query('DELETE FROM plans WHERE id=$1', [planId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await releaseCronLock(cronLock);
    await pool.end();
  }
}, 60000);

async function queueCharge(opts: { amount: number; period: string; mandate?: string; company?: string; sub?: string }): Promise<string> {
  const ref = `ceil_${crypto.randomUUID().slice(0, 12)}`;
  const { rows } = await pool.query(
    `INSERT INTO subscription_charges(company_id,subscription_id,mandate_id,period_start,period_end,
       amount_cents,currency,gateway,external_reference,paystack_reference,status)
     VALUES($1,$2,$3,$4::date,($4::date + interval '1 month')::date,$5,'ZAR','paystack',$6,$6,'queued') RETURNING id`,
    [opts.company ?? companyId, opts.sub ?? subscriptionId, opts.mandate ?? mandateId, opts.period, opts.amount, ref]);
  return rows[0].id as string;
}

/** Amounts sent to Paystack for this suite's companies (the run is process-wide; other suites' rows are not ours). */
const sentFor = (co: string) => chargeAuthorization.mock.calls
  .map((c) => c[0] as { amountCents: number; metadata: { company_id: string } })
  .filter((a) => a.metadata.company_id === co)
  .map((a) => a.amountCents);

const chargeRow = async (id: string) =>
  (await pool.query('SELECT status, attempt_count FROM subscription_charges WHERE id=$1', [id])).rows[0];

describe('mandate ceiling on the charge run', () => {
  it('charge above ceiling: skipped, not claimed, never sent; one at the ceiling is sent', async () => {
    const above = await queueCharge({ amount: CEILING + 1, period: '2026-01-01' });
    const at = await queueCharge({ amount: CEILING, period: '2026-02-01' });
    chargeAuthorization.mockRejectedValue(new Error('declined'));

    await runQueuedCharges();

    expect(sentFor(companyId)).toEqual([CEILING]);
    expect(await chargeRow(above)).toMatchObject({ status: 'queued', attempt_count: 0 });
    expect((await chargeRow(at)).attempt_count).toBe(1);
  }, 30000);

  it('selects the comparison exactly and orders above-ceiling charges after chargeable ones', async () => {
    const above = await queueCharge({ amount: CEILING + 1, period: '2026-01-01' });
    const at = await queueCharge({ amount: CEILING, period: '2026-02-01' });
    const mine = (await selectChargeableCharges()).filter((c) => c.company_id === companyId);
    expect(mine.map((c) => [c.id, c.above_mandate_ceiling])).toEqual([[at, false], [above, true]]);
  }, 30000);

  it('never selects a charge that points at another company\'s mandate', async () => {
    const crossed = await queueCharge({ amount: 100, period: '2026-03-01', mandate: otherMandateId });
    expect((await selectChargeableCharges()).map((c) => c.id)).not.toContain(crossed);
    await runQueuedCharges();
    expect(sentFor(companyId)).toEqual([]);
    expect(sentFor(otherCompanyId)).toEqual([]);
    expect(await chargeRow(crossed)).toMatchObject({ status: 'queued', attempt_count: 0 });
  }, 30000);

  it('a new mandate\'s ceiling must cover the live charge (annual price less discount), or it is refused unwritten', async () => {
    const charge = Math.round(CEILING * 10 * 0.9); // annual_price_cents with 10% off
    const start = (maxAmountCents: number) => startMandateCheckout({
      companyId: unmandatedCompanyId, userId, userEmail: 'owner@ceiling.test.local', maxAmountCents,
      callbackUrl: (r) => `https://app.example/return?ref=${r}`,
    });
    expect(await start(charge - 1)).toEqual({ kind: 'below_current_charge', currentChargeCents: charge });
    const { rows } = await pool.query('SELECT 1 FROM subscription_mandates WHERE company_id=$1', [unmandatedCompanyId]);
    expect(rows).toHaveLength(0);
    // At the charge it proceeds to Paystack (mocked to fail here, so the mandate row is marked failed).
    expect(await start(charge)).toEqual({ kind: 'init_failed' });
  }, 30000);
});
