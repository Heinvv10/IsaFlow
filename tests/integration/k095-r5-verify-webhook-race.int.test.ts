// tests/integration/k095-r5-verify-webhook-race.int.test.ts
//
// Round-5 blind review of 1d5aa28fd, HIGH-1.
//
// `verify` and the charge.success webhook are two observers of ONE transition.
// `activateAuthorisedMandate` read the mandate's status once, at the top of the
// request, and then treated its conditional UPDATE writing zero rows as proof
// that a DIFFERENT row held the company's active slot — `blocked`. The
// `status = 'pending'` predicate fails identically when the webhook activated
// THIS row in the meantime, and that window is exactly the duration of verify's
// outbound verifyTransaction call, which is when the webhook lands.
//
// Round 4 turned that into a durable, payer-visible lie: `authorisation_blocked`
// was persisted to paystack_payment_requests.failure_reason, the route answered
// `failed`, and the return page told the payer their card was charged but no
// mandate exists and to contact support — for a mandate that is active and
// chargeable. It never self-healed: pr.status was 'completed', so the live-verify
// block never ran again, and failure_reason was read back on every later poll.
//
// Both interleavings are exercised against the real DB with two pool clients,
// with the webhook committing on its own connection while the mocked Paystack
// call is in flight.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';

vi.mock('@/modules/accounting/services/ar/gatewayInvoiceReceiptService', () => ({
  recordGatewayInvoiceReceipt: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: vi.fn(),
}));

const DATABASE_URL = process.env.DATABASE_URL;

const LATE_CO = randomUUID();   // webhook lands DURING verify's Paystack call
const EARLY_CO = randomUUID();  // verify wins, webhook redelivers afterwards
const BLOCK_CO = randomUUID();  // a genuinely blocked activation must stay blocked
const FALL_CO = randomUUID();   // pre-651 fallback landing on another checkout's row
const STALE_CO = randomUUID();  // a failure_reason already persisted against an active row
const COMPANIES = [LATE_CO, EARLY_CO, BLOCK_CO, FALL_CO, STALE_CO];

const LATE_REF = `k095r5l_${randomUUID().slice(0, 8)}`;
const EARLY_REF = `k095r5e_${randomUUID().slice(0, 8)}`;
const BLOCK_REF = `k095r5b_${randomUUID().slice(0, 8)}`;
const FALL_REF = `k095r5f_${randomUUID().slice(0, 8)}`;
const STALE_REF = `k095r5s_${randomUUID().slice(0, 8)}`;

const AUTH_CODE = 'AUTH_k095r5_shared';

let lateMandate: string;
let earlyMandate: string;
let blockPending: string;
let blockActive: string;
let fallActive: string;
let staleMandate: string;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

function chargeSuccess(reference: string, authorizationCode: string) {
  return {
    event: 'charge.success',
    data: {
      reference,
      status: 'success',
      id: 919191,
      customer: { customer_code: 'CUS_k095r5' },
      authorization: {
        authorization_code: authorizationCode,
        last4: '3333',
        brand: 'visa',
        exp_month: '03',
        exp_year: '2033',
        bank: 'Race Bank',
      },
    },
  };
}

function liveSuccess(authorizationCode: string) {
  return {
    status: 'success',
    id: 919191,
    customer: { customerCode: 'CUS_k095r5' },
    authorization: {
      authorizationCode, last4: '3333', brand: 'visa',
      expMonth: '03', expYear: '2033', bank: 'Race Bank',
    },
  };
}

describeIfDb('K-095 r5 verify racing the webhook resolves to the truth, not to a stale read', () => {
  let admin: Pool;
  let processEvent: (t: string, e: ReturnType<typeof chargeSuccess>) => Promise<void>;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
  let verifyTransaction: ReturnType<typeof vi.fn>;
  let activateAuthorisedMandate: typeof import('@/modules/billing/services/paystackMandateActivation').activateAuthorisedMandate;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 5 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active)
       VALUES ($1, 'K095r5 Late', true), ($2, 'K095r5 Early', true),
              ($3, 'K095r5 Block', true), ($4, 'K095r5 Fallback', true),
              ($5, 'K095r5 Stale', true)`,
      COMPANIES,
    );

    const mandate = async (companyId: string, cents: number, status: string, code: string | null) => {
      const r = await admin.query(
        `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway,
           paystack_authorization_code, card_last4, card_brand, bank_name)
         VALUES ($1, $2, $3, 'paystack', $4, '7777', 'mastercard', 'Other Bank') RETURNING id`,
        [companyId, cents, status, code],
      );
      return r.rows[0].id as string;
    };

    lateMandate = await mandate(LATE_CO, 111111, 'pending', null);
    earlyMandate = await mandate(EARLY_CO, 222222, 'pending', null);
    blockActive = await mandate(BLOCK_CO, 333333, 'active', 'AUTH_k095r5_incumbent');
    blockPending = await mandate(BLOCK_CO, 444444, 'pending', null);
    // Checkout A is active; checkout B's access code was paid now. The request
    // predates 651, so it carries no link and the resolver falls back.
    fallActive = await mandate(FALL_CO, 999999, 'active', 'AUTH_k095r5_fall_first');
    await mandate(FALL_CO, 555555, 'pending', null);
    staleMandate = await mandate(STALE_CO, 666666, 'active', AUTH_CODE);

    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, mandate_id, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', $2, $3, 100, 'ZAR', 'pending'),
              ($4, 'authorization', $5, $6, 100, 'ZAR', 'pending'),
              ($7, 'authorization', $8, $9, 100, 'ZAR', 'pending'),
              ($10, 'authorization', NULL, $11, 100, 'ZAR', 'pending'),
              ($12, 'authorization', $13, $14, 100, 'ZAR', 'completed')`,
      [LATE_CO, lateMandate, LATE_REF, EARLY_CO, earlyMandate, EARLY_REF,
       BLOCK_CO, blockPending, BLOCK_REF, FALL_CO, FALL_REF,
       STALE_CO, staleMandate, STALE_REF],
    );

    ({ processEvent } = (await import(
      '../../src/modules/billing/services/paystackEventHandlers'
    )) as unknown as { processEvent: typeof processEvent });
    ({ activateAuthorisedMandate } = await import(
      '../../src/modules/billing/services/paystackMandateActivation'
    ));
    route = (await import('../../pages/api/billing/paystack/mandate/verify'))
      .default as unknown as typeof route;
    ({ verifyTransaction } = (await import(
      '../../src/modules/billing/services/paystackClient'
    )) as unknown as { verifyTransaction: ReturnType<typeof vi.fn> });
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM paystack_payment_requests WHERE company_id = ANY($1)', [COMPANIES]);
    await admin.query('DELETE FROM subscription_mandates WHERE company_id = ANY($1)', [COMPANIES]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', [COMPANIES]);
    await admin.end();
  });

  /** The charge.success webhook, on its OWN connection, committed. */
  async function webhookCommits(reference: string, code: string) {
    const client: PoolClient = await admin.connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, claims: {} }, () => processEvent('charge.success', chargeSuccess(reference, code)));
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  async function runVerify(companyId: string, ref: string) {
    const res = mockRes();
    const client: PoolClient = await admin.connect();
    let handlerError: unknown = null;
    let committed = false;
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: 'k095r5', companyId, claims: {} }, async () => {
        try {
          await route(
            { method: 'GET', query: { ref }, headers: {}, companyId, user: { id: 'k095r5' } } as unknown as NextApiRequest,
            res,
          );
        } catch (err) { handlerError = err; }
      });
      await client.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) { try { await client.query('ROLLBACK'); } catch { /* secondary */ } }
      client.release();
    }
    expect(handlerError).toBeNull();
    expect(committed).toBe(true);
    return (res.body as {
      data: {
        status: string; mandateId: string | null; failureReason?: string;
        maxAmountCents?: number; cardLast4?: string; cardBrand?: string; bankName?: string;
      };
    }).data;
  }

  async function mandateRow(id: string) {
    const { rows } = await admin.query(
      `SELECT status, paystack_authorization_code AS code FROM subscription_mandates WHERE id = $1`,
      [id],
    );
    return rows[0] as { status: string; code: string | null };
  }

  async function requestRow(ref: string) {
    const { rows } = await admin.query(
      `SELECT status, failure_reason FROM paystack_payment_requests WHERE paystack_reference = $1`,
      [ref],
    );
    return rows[0] as { status: string; failure_reason: string | null };
  }

  it('answers active, and writes no failure_reason, when the webhook commits DURING verify', async () => {
    // The webhook lands after verify has already read the mandate as 'pending'
    // and while the outbound Paystack call is in flight — the exact window the
    // round-4 code read as `blocked`.
    verifyTransaction.mockImplementationOnce(async () => {
      await webhookCommits(LATE_REF, AUTH_CODE);
      return liveSuccess(AUTH_CODE);
    });

    const body = await runVerify(LATE_CO, LATE_REF);

    expect(await mandateRow(lateMandate)).toEqual({ status: 'active', code: AUTH_CODE });
    // Before the fix: status 'failed', failureReason 'authorisation_blocked',
    // and the return page told the payer to contact support.
    expect(body.status).toBe('active');
    expect(body.mandateId).toBe(lateMandate);
    expect(body.failureReason).toBeUndefined();
    expect(body.maxAmountCents).toBe(111111);
    expect(await requestRow(LATE_REF)).toEqual({ status: 'completed', failure_reason: null });
  });

  it('a webhook redelivered AFTER verify already activated the row changes nothing', async () => {
    verifyTransaction.mockResolvedValueOnce(liveSuccess(AUTH_CODE));

    const body = await runVerify(EARLY_CO, EARLY_REF);
    expect(body.status).toBe('active');
    expect(body.failureReason).toBeUndefined();

    await webhookCommits(EARLY_REF, AUTH_CODE);

    expect(await mandateRow(earlyMandate)).toEqual({ status: 'active', code: AUTH_CODE });
    expect(await requestRow(EARLY_REF)).toEqual({ status: 'completed', failure_reason: null });

    // And a later poll — pr.status is 'completed', so the live-verify block is
    // skipped — still answers the truth rather than a persisted reason.
    const again = await runVerify(EARLY_CO, EARLY_REF);
    expect(again.status).toBe('active');
    expect(again.mandateId).toBe(earlyMandate);
    expect(again.failureReason).toBeUndefined();
  });

  it('two clients activating the SAME row report already_active, not blocked', async () => {
    const auth = {
      authorizationCode: AUTH_CODE, customerCode: null, last4: null,
      brand: null, expMonth: null, expYear: null, bank: null,
    };
    const stale = { id: earlyMandate, status: 'pending', authorizationCode: null, linked: true };

    // earlyMandate is already active from the previous test — this is the
    // second observer arriving with the stale 'pending' read it took before
    // the first one committed.
    const client: PoolClient = await admin.connect();
    let outcome: string;
    try {
      await client.query('BEGIN');
      outcome = await als.run({ client, claims: {} }, () =>
        activateAuthorisedMandate(EARLY_CO, stale, auth));
      // The transaction is still usable: nothing was aborted.
      await client.query('SELECT 1');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(outcome).toBe('already_active');
  });

  it('a genuinely blocked activation is still blocked, not healed into success', async () => {
    verifyTransaction.mockResolvedValueOnce(liveSuccess('AUTH_k095r5_second'));

    const body = await runVerify(BLOCK_CO, BLOCK_REF);

    // The incumbent holds the company's active slot, so the row this reference
    // paid for stays pending — and that must still be reported as a failure.
    expect(await mandateRow(blockPending)).toEqual({ status: 'pending', code: null });
    expect(await mandateRow(blockActive)).toEqual({ status: 'active', code: 'AUTH_k095r5_incumbent' });
    expect(body.status).toBe('failed');
    expect(body.failureReason).toBe('authorisation_blocked');
    expect(body.mandateId).toBe(blockPending);
    expect(await requestRow(BLOCK_REF)).toEqual({
      status: 'completed',
      failure_reason: 'authorisation_blocked',
    });
  });
  it('heals a failure_reason already persisted against this reference own active mandate', async () => {
    // What the round-4 code wrote before the re-read fix, and what any future
    // path could write again: a durable, payer-visible reason on a request
    // whose OWN linked mandate is active and chargeable. pr.status is
    // 'completed', so the live-verify block never runs and nothing clears it.
    await admin.query(
      `UPDATE paystack_payment_requests SET failure_reason = 'authorisation_blocked'
       WHERE paystack_reference = $1`,
      [STALE_REF],
    );

    const body = await runVerify(STALE_CO, STALE_REF);

    expect(body.status).toBe('active');
    expect(body.mandateId).toBe(staleMandate);
    expect(body.failureReason).toBeUndefined();
    expect(body.maxAmountCents).toBe(666666);
  });

  it('an unattributable fallback returns no card, bank or ceiling either, not just no id', async () => {
    verifyTransaction.mockResolvedValueOnce(liveSuccess('AUTH_k095r5_fall_second'));

    const body = await runVerify(FALL_CO, FALL_REF);

    expect(body.status).toBe('failed');
    expect(body.failureReason).toBe('authorisation_already_active_other_code');
    // The row the fallback landed on belongs to an EARLIER checkout. Hiding
    // its id while still returning its ceiling, card and bank identifies it
    // just as well — that is the mis-attribution 651 exists to retire.
    expect(body.mandateId).toBeNull();
    expect(body.maxAmountCents).toBeUndefined();
    expect(body.cardLast4).toBeUndefined();
    expect(body.cardBrand).toBeUndefined();
    expect(body.bankName).toBeUndefined();
    expect(await mandateRow(fallActive)).toEqual({ status: 'active', code: 'AUTH_k095r5_fall_first' });
  });
});

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    send(p: unknown) { this.body = p; return this; },
    end(p?: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}
