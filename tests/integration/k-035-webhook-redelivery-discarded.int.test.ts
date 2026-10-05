/**
 * K-035 — a Paystack delivery that fails must be redelivered and processed,
 * never acked as a duplicate. pages/api/webhooks/paystack.ts commits the
 * paystack_webhook_events row on the pool, then runs processEvent and the
 * `processed` stamp in one transaction: a throw rolls the transaction back,
 * the route answers 500 with processing_error recorded, and only an event whose
 * row says processed = TRUE is acked {duplicate:true} on redelivery.
 *
 * The failure is forced (R-190): the old fixture (two mandates tripping
 * ux_sub_mandates_company_active) is now a settled outcome that answers 200,
 * see paystackMandateActivation.ts. The sql wrapper below lets each statement
 * run on the real database and, while armed, throws straight after one chosen
 * statement:
 *   'stamp'   — the `UPDATE paystack_webhook_events SET processed = TRUE`, the
 *               last write inside the transaction, after every handler write;
 *   'handler' — the first `UPDATE paystack_payment_requests`, so the throw
 *               comes from inside processEvent itself.
 * Before throwing, the hook reads the request and mandate through the same
 * transaction, so a case can prove the writes it expects rolled back had
 * really happened. The hook disarms when it fires; each case arms it for one
 * delivery, so it never reaches the route's outer processing_error UPDATE.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createHash, createHmac } from 'crypto';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';

type Seen = { request: string | undefined; mandate: string | undefined };
type RealSql = (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
const hooks = vi.hoisted(() => ({
  armed: null as null | 'stamp' | 'handler',
  fired: 0,
  seen: null as null | Seen,
  probe: null as null | ((q: RealSql) => Promise<Seen>),
}));
const FORCED = 'R-190 forced processing failure';
const STATEMENT = {
  stamp: (t: string) =>
    /^\s*UPDATE\s+paystack_webhook_events\b/.test(t) && /SET\s+processed\s*=\s*TRUE/i.test(t),
  handler: (t: string) => /^\s*UPDATE\s+paystack_payment_requests\b/.test(t),
};

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as RealSql;
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const rows = await realSql(strings, ...values);
    const point = hooks.armed;
    if (point && STATEMENT[point](strings.join('?'))) {
      hooks.armed = null;
      hooks.fired += 1;
      hooks.seen = hooks.probe ? await hooks.probe(realSql) : null;
      throw new Error(FORCED);
    }
    return rows;
  };
  return { ...real, sql };
});

assertDisposable();

import webhook from '../../pages/api/webhooks/paystack';

const SECRET = 'sk_test_k035_disposable_secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const mandateId = crypto.randomUUID();
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

type StatusRows = Array<{ status: string }>;
hooks.probe = async (q) => ({
  request: ((await q`SELECT status FROM paystack_payment_requests
    WHERE id = ${prId} AND company_id = ${companyId}`) as StatusRows)[0]?.status,
  mandate: ((await q`SELECT status FROM subscription_mandates
    WHERE id = ${mandateId} AND company_id = ${companyId}`) as StatusRows)[0]?.status,
});

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
  hooks.armed = null;
  hooks.fired = 0;
  hooks.seen = null;
  await pool.query('DELETE FROM paystack_webhook_events WHERE body_sha256=$1', [bodyHash]);
  await pool.query('DELETE FROM paystack_payment_requests WHERE company_id=$1', [companyId]);
  await pool.query('DELETE FROM subscription_mandates WHERE company_id=$1', [companyId]);
  await pool.query(
    `INSERT INTO subscription_mandates(id,company_id,max_amount_cents,authorised_by,status,gateway)
     VALUES($1,$2,$3,$4,'pending','paystack')`,
    [mandateId, companyId, 10_000_00, userId],
  );
  await pool.query(
    `INSERT INTO paystack_payment_requests(id,company_id,purpose,paystack_reference,amount_cents,status,mandate_id)
     VALUES($1,$2,'authorization',$3,$4,'pending',$5)`,
    [prId, companyId, reference, 10000, mandateId],
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
const readRequest = async () =>
  (await pool.query('SELECT status FROM paystack_payment_requests WHERE id=$1', [prId])).rows[0];
const readMandate = async () =>
  (await pool.query(
    'SELECT status, paystack_authorization_code FROM subscription_mandates WHERE id=$1',
    [mandateId],
  )).rows[0];

describe('K-035 failed payment webhooks are redelivered, not discarded', () => {
  it('answers 500 and leaves the event row unprocessed with its error recorded', async () => {
    hooks.armed = 'stamp';
    const first = await deliver();
    expect(hooks.fired).toBe(1);
    expect(first.state.statusCode).toBe(500);
    const event = await readEvent();
    expect(event?.processed).toBe(false);
    expect(event?.processing_error).toBe(FORCED);
  });

  it('processes a redelivery of a failed event rather than acking it as a duplicate', async () => {
    hooks.armed = 'stamp';
    const first = await deliver();
    expect(first.state.statusCode).toBe(500);

    // The cause is still present: the right answer is a second 500, never a
    // 200 {duplicate:true}, which would discard the event silently.
    hooks.armed = 'stamp';
    const second = await deliver();
    expect(hooks.fired).toBe(2);
    expect(second.state.body).not.toMatchObject({ duplicate: true });
    expect(second.state.statusCode).toBe(500);
    expect((await readEvent())?.processed).toBe(false);
  });

  it('processes the redelivery once the cause of the failure is cleared', async () => {
    hooks.armed = 'stamp';
    const first = await deliver();
    expect(hooks.fired).toBe(1);
    expect(first.state.statusCode).toBe(500);

    const second = await deliver();
    expect(second.state.statusCode).toBe(200);
    expect(second.state.body).toMatchObject({ ok: true });
    expect(await readEvent()).toEqual({ processed: true, processing_error: null });
    expect((await readRequest()).status).toBe('completed');
    expect(await readMandate()).toEqual({ status: 'active', paystack_authorization_code: 'AUTH_k035_new' });
  });

  it('rolls the payment request back to pending when processing fails', async () => {
    hooks.armed = 'stamp';
    await deliver();
    expect(hooks.fired).toBe(1);
    expect(hooks.seen?.request).toBe('completed'); // written, then rolled back
    // A committed 'completed' would shut the branch for every retry
    // (`AND status <> 'completed'`), so the authorisation would never attach.
    expect((await readRequest()).status).toBe('pending');
  });

  it('rolls back the mandate activation too, not just the payment request', async () => {
    hooks.armed = 'stamp';
    await deliver();
    expect(hooks.fired).toBe(1);
    expect(hooks.seen?.mandate).toBe('active'); // written, then rolled back
    expect(await readMandate()).toEqual({ status: 'pending', paystack_authorization_code: null });
  });

  it('treats a throw from inside processEvent as a failure, then processes the redelivery', async () => {
    hooks.armed = 'handler';
    const first = await deliver();
    expect(hooks.fired).toBe(1);
    expect(hooks.seen?.request).toBe('completed'); // the handler's own write, rolled back below
    expect(first.state.statusCode).toBe(500);
    expect(await readEvent()).toEqual({ processed: false, processing_error: FORCED });
    expect((await readRequest()).status).toBe('pending');
    expect((await readMandate()).status).toBe('pending');

    const second = await deliver();
    expect(second.state.statusCode).toBe(200);
    expect(second.state.body).toMatchObject({ ok: true });
    expect(await readEvent()).toEqual({ processed: true, processing_error: null });
    expect((await readRequest()).status).toBe('completed');
    expect(await readMandate()).toEqual({ status: 'active', paystack_authorization_code: 'AUTH_k035_new' });
  });

  it('still acks a redelivery of an event that was processed successfully', async () => {
    const first = await deliver();
    expect(first.state.statusCode).toBe(200);

    // Armed for the redelivery: a duplicate never reaches the handler.
    hooks.armed = 'handler';
    const second = await deliver();
    expect(hooks.fired).toBe(0);
    expect(second.state.statusCode).toBe(200);
    expect(second.state.body).toMatchObject({ duplicate: true });

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM paystack_webhook_events WHERE body_sha256=$1',
      [bodyHash],
    );
    expect(rows[0].n).toBe(1);
  });
});
