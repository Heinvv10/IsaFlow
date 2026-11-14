/**
 * Shared fixture for the admin-cancel charge suites (audit 3.1): one company
 * with one active subscription (period ended yesterday) and an active mandate,
 * a second tenant the cancel must not touch, and the real admin route handlers.
 * The Paystack stub and vi.mock stay in each suite (vi.mock is per file).
 */
import type { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import cancelRoute from '../../../pages/api/admin/billing/subscriptions/[id]/cancel';
import patchRoute from '../../../pages/api/admin/billing/subscriptions/[id]';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import { signSession } from '../r-032-fake-gotrue.helpers';

export { cancelRoute, patchRoute };

/** UTC calendar date, `offset` days from now (the charge period columns are DATEs). */
export const day = (offset: number) =>
  new Date(Date.now() + offset * 24 * 3600_000).toISOString().slice(0, 10);

export interface ChargeSpec {
  company: string; subscription: string; mandate: string; start: number; end: number;
  status: string; attempts?: number; lastAttemptHoursAgo?: number;
}

export function adminCancelFixture(pool: Pool) {
  const ids = {
    admin: crypto.randomUUID(), company: crypto.randomUUID(), other: crypto.randomUUID(),
    plan: crypto.randomUUID(), mandate: crypto.randomUUID(), otherMandate: crypto.randomUUID(),
    sub: crypto.randomUUID(), otherSub: crypto.randomUUID(),
  };
  const charges = { queued: '', failed: '', other: '' };

  async function insertMandate(id: string, company: string, tag: string) {
    await pool.query(
      `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway,
         paystack_authorization_code,paystack_customer_code,authorised_at)
       VALUES($1,$2,1000000,$3,'active','paystack',$4,$5,now())`,
      [id, company, ids.admin, `AUTH_${tag}`, `CUS_${tag}`],
    );
  }

  async function insertSubscription(id: string, company: string, periodEndDays = -1) {
    await pool.query(
      `INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,
         current_period_start,current_period_end,cancel_at_period_end,discount_percent)
       VALUES($1,$2,$3,'active','monthly',now() + ($4::int - 30) * interval '1 day',
              now() + $4::int * interval '1 day',false,0)`,
      [id, company, ids.plan, periodEndDays],
    );
  }

  async function insertCharge(o: ChargeSpec): Promise<string> {
    const ref = `adm_cancel_${crypto.randomUUID()}`;
    const { rows } = await pool.query(
      `INSERT INTO subscription_charges(company_id,subscription_id,mandate_id,period_start,period_end,
         amount_cents,currency,gateway,external_reference,paystack_reference,status,attempt_count,last_attempt_at)
       VALUES($1,$2,$3,$4,$5,29900,'ZAR','paystack',$6,$6,$7,$8,
         CASE WHEN $9::int IS NULL THEN NULL ELSE now() - ($9::int * interval '1 hour') END)
       RETURNING id`,
      [o.company, o.subscription, o.mandate, day(o.start), day(o.end), ref, o.status,
        o.attempts ?? 0, o.lastAttemptHoursAgo ?? null],
    );
    return rows[0].id as string;
  }

  /** A failed debt, past its backoff, for a period the subscription was already granted (-32..-2 days). */
  const insertGrantedDebt = () => insertCharge({ company: ids.company, subscription: ids.sub,
    mandate: ids.mandate, start: -32, end: -2, status: 'failed', attempts: 1, lastAttemptHoursAgo: 25 });

  async function chargeStatus(id: string): Promise<{ status: string; attempt_count: number }> {
    const { rows } = await pool.query('SELECT status, attempt_count FROM subscription_charges WHERE id=$1', [id]);
    return rows[0] as { status: string; attempt_count: number };
  }

  async function subscriptionRow(id = ids.sub): Promise<{ status: string; cancelled_at: Date | null }> {
    const { rows } = await pool.query('SELECT status, cancelled_at FROM subscriptions WHERE id=$1', [id]);
    return rows[0] as { status: string; cancelled_at: Date | null };
  }

  /** Calls the real admin route handler exactly as the console does. */
  async function callRoute(route: typeof cancelRoute | typeof patchRoute, method: string, body: unknown,
    target = ids.sub): Promise<{ status: number; body: unknown }> {
    const jar = { 'sb-access-token': await signSession(ids.admin, crypto.randomUUID(), 'aal2') };
    const req = request(jar, method, target) as unknown as NextApiRequest & { body: unknown };
    req.body = body;
    const result = response();
    await route(req as never, result.res);
    return { status: result.state.statusCode, body: result.state.body };
  }

  async function setup() {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
      [ids.company, 'Admin cancel fixture', ids.other, 'Admin cancel other tenant']);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'super_admin',true)",
      [ids.admin, `${ids.admin}@test.local`]);
    await pool.query(
      'INSERT INTO plans(id,code,name,monthly_price_cents,annual_price_cents) VALUES($1,$2,$3,29900,299000)',
      [ids.plan, `adm-cancel-${ids.plan.slice(0, 8)}`, 'Admin cancel plan'],
    );
    await insertMandate(ids.mandate, ids.company, 'adm1');
    await insertMandate(ids.otherMandate, ids.other, 'adm2');
  }

  /** Per test: active subscription, one queued and one failed-past-backoff charge, both for ungranted periods. */
  async function reset() {
    // withAdmin allows 120 requests a minute per IP, and the counter outlives a run: back-to-back
    // runs (or other suites sharing this IP key) would answer 429 and silently skip a cancel.
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
    for (const c of [ids.company, ids.other]) {
      await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [c]);
    }
    await insertSubscription(ids.sub, ids.company);
    await insertSubscription(ids.otherSub, ids.other);
    charges.queued = await insertCharge({ company: ids.company, subscription: ids.sub, mandate: ids.mandate,
      start: -1, end: 29, status: 'queued' });
    charges.failed = await insertCharge({ company: ids.company, subscription: ids.sub, mandate: ids.mandate,
      start: 29, end: 59, status: 'failed', attempts: 1, lastAttemptHoursAgo: 25 });
    charges.other = await insertCharge({ company: ids.other, subscription: ids.otherSub,
      mandate: ids.otherMandate, start: -1, end: 29, status: 'queued' });
  }

  async function teardown() {
    for (const c of [ids.company, ids.other]) {
      await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM subscription_charges WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM subscriptions WHERE company_id=$1', [c]);
      await pool.query('DELETE FROM subscription_mandates WHERE company_id=$1', [c]);
    }
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [ids.admin]);
    await pool.query('DELETE FROM companies WHERE id IN ($1,$2)', [ids.company, ids.other]);
    await pool.query('DELETE FROM plans WHERE id=$1', [ids.plan]);
    await pool.query('DELETE FROM users WHERE id=$1', [ids.admin]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
  }

  return { ids, charges, insertSubscription, insertCharge, insertGrantedDebt, chargeStatus,
    subscriptionRow, callRoute, setup, reset, teardown };
}
