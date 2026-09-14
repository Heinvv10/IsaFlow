/**
 * K-035 RED — pages/api/webhooks/paystack.ts commits the
 * paystack_webhook_events row (line 128-132) on its own auto-commit
 * connection BEFORE processEvent runs. When processing throws the handler
 * answers 500 (line 154) but the event row survives, so Paystack's
 * redelivery of the identical body hits the body_sha256 dedupe check at
 * line 123-126 and is acked 200 as a duplicate, never processed.
 *
 * The processing failure used here is real, not injected: two mandates for
 * one company (one active, one pending) make the 'authorization' branch's
 * blanket UPDATE violate ux_sub_mandates_company_active. No Paystack network
 * call is made — the webhook route never calls the provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createHash, createHmac } from 'crypto';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();

import webhook from '../../pages/api/webhooks/paystack';

const SECRET = 'sk_test_k035_disposable_secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const activeMandateId = crypto.randomUUID();
const pendingMandateId = crypto.randomUUID();
const prId = crypto.randomUUID();
const reference = `k035_${prId.slice(0, 12)}`;

const eventBody = JSON.stringify({
  event: 'charge.success',
  data: {
    id: 987654321,
    reference,
    status: 'success',
    amount: 10000,
    currency: 'ZAR',
    channel: 'card',
    customer: { email: 'payer@k035.test.local', customer_code: 'CUS_k035' },
    authorization: {
      authorization_code: 'AUTH_k035_new',
      last4: '4081',
      brand: 'visa',
      exp_month: '12',
      exp_year: '2030',
      bank: 'Test Bank',
      reusable: true,
    },
  },
});
const bodyHash = createHash('sha256').update(eventBody).digest('hex');

function deliver() {
  const req = Readable.from([Buffer.from(eventBody)]) as unknown as NextApiRequest;
  (req as { method: string }).method = 'POST';
  (req as { headers: Record<string, string> }).headers = {
    'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', SECRET).update(eventBody).digest('hex'),
  };
  const result = response();
  return webhook(req, result.res).then(() => result);
}

beforeAll(async () => {
  vi.stubEnv('PAYSTACK_SECRET_KEY', SECRET);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, 'K-035 fixture']);
  await pool.query(
    "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@k035.test.local`],
  );
});

beforeEach(async () => {
  await pool.query('DELETE FROM paystack_webhook_events WHERE body_sha256=$1', [bodyHash]);
  await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM subscription_mandates WHERE company_id=$1', [companyId]);
  await pool.query(
    `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway,
       paystack_authorization_code,authorised_at)
     VALUES($1,$2,$3,$4,'active','paystack','AUTH_k035_old',now()),
            ($5,$2,$3,$4,'pending','paystack',NULL,NULL)`,
    [activeMandateId, companyId, 10_000_00, userId, pendingMandateId],
  );
  await pool.query(
    `INSERT INTO paystack_payment_requests(id,company_id,purpose,paystack_reference,amount_cents,status)
     VALUES($1,$2,'authorization',$3,$4,'pending')`,
    [prId, companyId, reference, 10000],
  );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  try {
    await pool.query('DELETE FROM paystack_webhook_events WHERE body_sha256=$1', [bodyHash]);
    await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM subscription_mandates WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await pool.end();
  }
});

async function readEvent() {
  const { rows } = await pool.query(
    'SELECT processed, processing_error FROM paystack_webhook_events WHERE body_sha256=$1',
    [bodyHash],
  );
  return rows[0] as { processed: boolean; processing_error: string | null } | undefined;
}

describe('K-035 failed payment webhooks are discarded on retry', () => {
  it('commits the event row before processing, so a 500 leaves an unprocessed row behind', async () => {
    const first = await deliver();
    expect(first.state.statusCode).toBe(500);
    const event = await readEvent();
    expect(event?.processed).toBe(false);
    expect(event?.processing_error).toBeTruthy();
  });

  it('must process the redelivered event rather than acking it as a duplicate', async () => {
    const first = await deliver();
    expect(first.state.statusCode).toBe(500);

    // Paystack redelivers the byte-identical payload. The cause of the failure
    // is still present, so the correct answer is a second 500 — never a
    // 200 {duplicate:true}, which would discard the event silently.
    const second = await deliver();

    expect(second.state.body).not.toMatchObject({ duplicate: true });
    expect(second.state.statusCode).toBe(500);
    const event = await readEvent();
    expect(event?.processed).toBe(false);
  });

  it('processes the redelivery once the cause of the failure is cleared', async () => {
    const first = await deliver();
    expect(first.state.statusCode).toBe(500);

    // Operator removes the duplicate pending mandate that broke the UPDATE.
    await pool.query('DELETE FROM subscription_mandates WHERE id=$1', [pendingMandateId]);

    const second = await deliver();
    expect(second.state.statusCode).toBe(200);
    expect(second.state.body).toMatchObject({ ok: true });

    const event = await readEvent();
    expect(event?.processed).toBe(true);

    const { rows: prRows } = await pool.query(
      'SELECT status FROM paystack_payment_requests WHERE id=$1',
      [prId],
    );
    expect(prRows[0].status).toBe('completed');
    const { rows: mandateRows } = await pool.query(
      'SELECT status, paystack_authorization_code FROM subscription_mandates WHERE id=$1',
      [activeMandateId],
    );
    expect(mandateRows[0]).toMatchObject({
      status: 'active',
      paystack_authorization_code: 'AUTH_k035_new',
    });
  });

  it('leaves the payment request marked completed even though processing failed', async () => {
    await deliver();
    const { rows } = await pool.query(
      'SELECT status FROM paystack_payment_requests WHERE id=$1',
      [prId],
    );
    // The UPDATE ... RETURNING at line 206 auto-commits before the throw, so a
    // retry can never re-enter the branch (`AND status <> 'completed'`).
    expect(rows[0].status).toBe('pending');
  });

  it('rolls back every write of the failed delivery, not just the payment request', async () => {
    await deliver();
    const { rows } = await pool.query(
      'SELECT status, paystack_authorization_code FROM subscription_mandates WHERE id=$1',
      [activeMandateId],
    );
    expect(rows[0]).toMatchObject({
      status: 'active',
      paystack_authorization_code: 'AUTH_k035_old',
    });
  });

  it('still acks a redelivery of an event that was processed successfully', async () => {
    await pool.query('DELETE FROM subscription_mandates WHERE id=$1', [pendingMandateId]);
    const first = await deliver();
    expect(first.state.statusCode).toBe(200);

    const second = await deliver();
    expect(second.state.statusCode).toBe(200);
    expect(second.state.body).toMatchObject({ duplicate: true });

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM paystack_webhook_events WHERE body_sha256=$1',
      [bodyHash],
    );
    expect(rows[0].n).toBe(1);
  });
});
