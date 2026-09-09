// tests/integration/k095-mandate-activation-guards.int.test.ts
//
// HIGH-1 / MEDIUM-1 / LOW-1 / LOW-3 from the round-2 blind review of 3392181b1.
//
// Scoping the activation to ONE mandate removed the two-pending-rows case but
// not the one that matters: `ux_sub_mandates_company_active` is a UNIQUE index
// on (company_id) WHERE status = 'active', so a blind `SET status = 'active'`
// still raises 23505 whenever the company ALREADY has a different active
// mandate. That is reachable from an ordinary abandoned-then-retried checkout
// (Paystack access codes stay payable after the customer walks away). In the
// webhook the throw rolls the whole event back, `processed` stays FALSE, the
// route answers 500 and every redelivery repeats it forever — with the card
// already charged.
//
// Cases:
//   1. HIGH-1. The company already has an active mandate. charge.success for
//      the OTHER checkout must not throw, must leave the request transaction
//      usable and committable, must not touch either mandate, and must record
//      why on the payment request (LOW-3).
//   2. LOW-1. A revoked mandate is never resurrected by a payment event.
//   3. HIGH-1 under concurrency. Two checkouts activate at once: the index is
//      the arbiter, the loser reports `blocked` from inside its savepoint and
//      does NOT abort its caller's transaction.
//   4. MEDIUM-1. The verify route reports the mandate THIS reference is linked
//      to — its id and its ceiling — not the company's newest/active row.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';

vi.mock('@/modules/accounting/services/ar/gatewayInvoiceReceiptService', () => ({
  recordGatewayInvoiceReceipt: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));

const verifyTransaction = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (ref: string) => verifyTransaction(ref),
}));

const DATABASE_URL = process.env.DATABASE_URL;

const BLOCKED_CO = randomUUID();
const REVOKED_CO = randomUUID();
const RACE_CO = randomUUID();
const VERIFY_CO = randomUUID();
const COMPANIES = [BLOCKED_CO, REVOKED_CO, RACE_CO, VERIFY_CO];

const BLOCKED_REF = `k095b_${randomUUID().slice(0, 8)}`;
const REVOKED_REF = `k095r_${randomUUID().slice(0, 8)}`;
const VERIFY_REF = `k095v_${randomUUID().slice(0, 8)}`;

let alreadyActive: string;
let secondCheckout: string;
let revokedMandate: string;
let raceOne: string;
let raceTwo: string;
let linkedMandate: string;
let newerActiveMandate: string;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

function chargeSuccess(reference: string) {
  return {
    event: 'charge.success',
    data: {
      reference,
      status: 'success',
      id: 515151,
      customer: { customer_code: 'CUS_k095' },
      authorization: {
        authorization_code: 'AUTH_k095_new',
        last4: '1111',
        brand: 'mastercard',
        exp_month: '01',
        exp_year: '2031',
        bank: 'Second Bank',
      },
    },
  };
}

describeIfDb('K-095 a second active mandate is refused, not thrown', () => {
  let admin: Pool;
  let processEvent: (t: string, e: ReturnType<typeof chargeSuccess>) => Promise<void>;
  let activateAuthorisedMandate: typeof import('@/modules/billing/services/paystackMandateActivation').activateAuthorisedMandate;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 5 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active)
       VALUES ($1, 'K095 Blocked', true), ($2, 'K095 Revoked', true),
              ($3, 'K095 Race', true), ($4, 'K095 Verify', true)`,
      COMPANIES,
    );

    const mandate = async (companyId: string, cents: number, status: string, extra = '') => {
      const r = await admin.query(
        `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, paystack_authorization_code, created_at)
         VALUES ($1, $2, $3, 'paystack', $4, now() ${extra}) RETURNING id`,
        [companyId, cents, status, status === 'active' ? 'AUTH_k095_existing' : null],
      );
      return r.rows[0].id as string;
    };

    // Checkout A completed and activated; checkout B was still open and the
    // customer paid it afterwards.
    alreadyActive = await mandate(BLOCKED_CO, 100000, 'active', `- interval '2 days'`);
    secondCheckout = await mandate(BLOCKED_CO, 999999, 'pending');

    revokedMandate = await mandate(REVOKED_CO, 400000, 'revoked');

    raceOne = await mandate(RACE_CO, 300000, 'pending', `- interval '1 hour'`);
    raceTwo = await mandate(RACE_CO, 600000, 'pending');

    // The reference under test points at the OLDER pending mandate; the
    // company's newest row is active with a different ceiling and card.
    linkedMandate = await mandate(VERIFY_CO, 111111, 'pending', `- interval '1 day'`);
    newerActiveMandate = await mandate(VERIFY_CO, 222222, 'active');
    await admin.query(
      `UPDATE subscription_mandates SET card_last4 = '9999', card_brand = 'amex' WHERE id = $1`,
      [newerActiveMandate],
    );

    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, mandate_id, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', $2, $3, 100, 'ZAR', 'pending'),
              ($4, 'authorization', $5, $6, 100, 'ZAR', 'pending'),
              ($7, 'authorization', $8, $9, 100, 'ZAR', 'pending')`,
      [
        BLOCKED_CO, secondCheckout, BLOCKED_REF,
        REVOKED_CO, revokedMandate, REVOKED_REF,
        VERIFY_CO, linkedMandate, VERIFY_REF,
      ],
    );

    ({ processEvent } = (await import(
      '../../src/modules/billing/services/paystackEventHandlers'
    )) as unknown as { processEvent: typeof processEvent });
    ({ activateAuthorisedMandate } = await import(
      '../../src/modules/billing/services/paystackMandateActivation'
    ));
    route = (await import('../../pages/api/billing/paystack/mandate/verify'))
      .default as unknown as typeof route;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM paystack_payment_requests WHERE company_id = ANY($1)', [COMPANIES]);
    await admin.query('DELETE FROM subscription_mandates WHERE company_id = ANY($1)', [COMPANIES]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', [COMPANIES]);
    await admin.end();
  });

  /** The webhook's shape: one ALS-bound transaction, committed at the end. */
  async function inWebhookTx(fn: () => Promise<void>) {
    const client: PoolClient = await admin.connect();
    let thrown: unknown = null;
    let txUsable = false;
    let committed = false;
    try {
      await client.query('BEGIN');
      await als.run({ client, claims: {} }, async () => {
        try {
          await fn();
        } catch (err) {
          thrown = err;
        }
        // A 23505 that escaped its savepoint aborts the transaction and this
        // raises 25P02 — the state that turns into a 500 and a redelivery loop.
        try {
          await client.query('SELECT 1');
          txUsable = true;
        } catch {
          txUsable = false;
        }
      });
      await client.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) { try { await client.query('ROLLBACK'); } catch { /* secondary */ } }
      client.release();
    }
    return { thrown, txUsable, committed };
  }

  async function mandateRow(id: string) {
    const { rows } = await admin.query(
      `SELECT status, paystack_authorization_code AS code, max_amount_cents FROM subscription_mandates WHERE id = $1`,
      [id],
    );
    return rows[0] as { status: string; code: string | null; max_amount_cents: string };
  }

  async function requestRow(ref: string) {
    const { rows } = await admin.query(
      `SELECT status, failure_reason FROM paystack_payment_requests WHERE paystack_reference = $1`,
      [ref],
    );
    return rows[0] as { status: string; failure_reason: string | null };
  }

  it('refuses a second active mandate without throwing or poisoning the transaction', async () => {
    const { thrown, txUsable, committed } = await inWebhookTx(() =>
      processEvent('charge.success', chargeSuccess(BLOCKED_REF)),
    );

    expect(thrown).toBeNull();
    expect(txUsable).toBe(true);
    expect(committed).toBe(true);

    // Neither mandate moved: the one already active keeps its own
    // authorization, and the losing checkout is not activated behind it.
    expect(await mandateRow(alreadyActive)).toMatchObject({ status: 'active', code: 'AUTH_k095_existing' });
    expect(await mandateRow(secondCheckout)).toMatchObject({ status: 'pending', code: null });

    const { rows } = await admin.query(
      `SELECT COUNT(*)::int AS n FROM subscription_mandates WHERE company_id = $1 AND status = 'active'`,
      [BLOCKED_CO],
    );
    expect(rows[0].n).toBe(1);

    // LOW-3: the money was taken, so the request stays completed — but a
    // completed authorisation attached to nothing has to say so.
    expect(await requestRow(BLOCKED_REF)).toEqual({
      status: 'completed',
      failure_reason: 'authorisation_blocked',
    });
  });

  it('never resurrects a revoked mandate from a payment event', async () => {
    const { thrown, txUsable, committed } = await inWebhookTx(() =>
      processEvent('charge.success', chargeSuccess(REVOKED_REF)),
    );

    expect(thrown).toBeNull();
    expect(txUsable).toBe(true);
    expect(committed).toBe(true);
    expect(await mandateRow(revokedMandate)).toMatchObject({ status: 'revoked', code: null });
    expect(await requestRow(REVOKED_REF)).toEqual({
      status: 'completed',
      failure_reason: 'authorisation_not_pending',
    });
  });

  it('lets the unique index arbitrate two concurrent activations', async () => {
    const auth = {
      authorizationCode: 'AUTH_k095_race',
      customerCode: null, last4: null, brand: null,
      expMonth: null, expYear: null, bank: null,
    };

    const run = async (client: PoolClient, mandateId: string) =>
      als.run({ client, claims: {} }, () =>
        activateAuthorisedMandate(
          RACE_CO,
          { id: mandateId, status: 'pending', authorizationCode: null, linked: true },
          auth,
        ),
      );

    const a = await admin.connect();
    const b = await admin.connect();
    let outcomeA: string; let outcomeB: string;
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      outcomeA = await run(a, raceOne);
      // B's UPDATE passes NOT EXISTS (A is uncommitted) and then blocks on the
      // unique index until A commits.
      const pendingB = run(b, raceTwo);
      await a.query('COMMIT');
      outcomeB = await pendingB;

      // The savepoint absorbed the 23505, so B's transaction is still usable.
      await b.query('SELECT 1');
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }

    expect(outcomeA).toBe('activated');
    expect(outcomeB).toBe('blocked');
    expect(await mandateRow(raceOne)).toMatchObject({ status: 'active' });
    expect(await mandateRow(raceTwo)).toMatchObject({ status: 'pending' });
  });

  it('verify reports the linked mandate, not the company newest active row', async () => {
    verifyTransaction.mockResolvedValueOnce({
      status: 'success',
      id: 626262,
      customer: { customerCode: 'CUS_k095v' },
      authorization: { authorizationCode: 'AUTH_k095v', last4: '4444', brand: 'visa', bank: 'Linked Bank' },
    });

    const res = mockRes();
    const client: PoolClient = await admin.connect();
    let handlerError: unknown = null;
    let committed = false;
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: 'k095', companyId: VERIFY_CO, claims: {} }, async () => {
        try {
          await route(
            { method: 'GET', query: { ref: VERIFY_REF }, headers: {}, companyId: VERIFY_CO, user: { id: 'k095' } } as unknown as NextApiRequest,
            res,
          );
        } catch (err) {
          handlerError = err;
        }
      });
      await client.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) { try { await client.query('ROLLBACK'); } catch { /* secondary */ } }
      client.release();
    }

    expect(handlerError).toBeNull();
    expect(res.statusCode).toBe(200);
    const body = (res.body as { data: { status: string; mandateId: string; failureReason?: string; maxAmountCents?: number; cardLast4?: string } }).data;

    // The activation was blocked by the newer active row, so this reference's
    // mandate is still pending — and that, with ITS ceiling, is what the caller
    // is told. Reading the company's newest row instead answered 'active' with
    // 222222 and card 9999 for a reference that authorised neither.
    expect(body.mandateId).toBe(linkedMandate);
    // The payment completed and activated nothing, so the reference reports
    // `failed` with its reason — not 'pending' forever to an admin who was
    // just charged.
    expect(body.status).toBe('failed');
    expect(body.failureReason).toBe('authorisation_blocked');
    expect(body.maxAmountCents).toBe(111111);
    expect(body.cardLast4).toBeUndefined();

    expect(await mandateRow(newerActiveMandate)).toMatchObject({ status: 'active' });
    expect(await requestRow(VERIFY_REF)).toEqual({
      status: 'completed',
      failure_reason: 'authorisation_blocked',
    });
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
