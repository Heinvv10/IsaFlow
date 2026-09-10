// tests/integration/k095-r4-fallback-attribution.int.test.ts
//
// Round-4 blind review of 131bf415d — MEDIUM-1 and LOW-2, end to end.
//
// MEDIUM-1. A payment request written BEFORE migration 651 carries no
// mandate_id, so the resolver falls back to the company's newest paystack
// mandate, ACTIVE FIRST. Active-first is what makes a webhook redelivery
// idempotent — but when a second checkout is paid it returns the mandate that
// is ALREADY active, `activateAuthorisedMandate` short-circuits, and both
// callers read that as success: no failure_reason, no warn, a charged card and
// a captured authorization code silently discarded.
//
// LOW-2. verify.ts chose its fallback re-read on `mandate === null`, not on
// whether the request HAD a link. A request whose mandate_id no longer
// resolves therefore fell back to the company-newest heuristic and reported
// another mandate's id, ceiling and card under this reference.

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

const SECOND_CO = randomUUID();
const REDELIVER_CO = randomUUID();
const DANGLE_CO = randomUUID();
const OTHER_CO = randomUUID();
const COMPANIES = [SECOND_CO, REDELIVER_CO, DANGLE_CO, OTHER_CO];

const SECOND_REF = `k095s_${randomUUID().slice(0, 8)}`;
const REDELIVER_REF = `k095d_${randomUUID().slice(0, 8)}`;
const DANGLE_REF = `k095g_${randomUUID().slice(0, 8)}`;

let secondActive: string;
let secondPending: string;
let redeliverActive: string;
let dangleOwnActive: string;
let foreignMandate: string;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

function chargeSuccess(reference: string, authorizationCode: string) {
  return {
    event: 'charge.success',
    data: {
      reference,
      status: 'success',
      id: 717171,
      customer: { customer_code: 'CUS_k095r4' },
      authorization: {
        authorization_code: authorizationCode,
        last4: '2222',
        brand: 'visa',
        exp_month: '02',
        exp_year: '2032',
        bank: 'Fallback Bank',
      },
    },
  };
}

describeIfDb('K-095 r4 the pre-651 fallback never reports a second checkout as success', () => {
  let admin: Pool;
  let processEvent: (t: string, e: ReturnType<typeof chargeSuccess>) => Promise<void>;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active)
       VALUES ($1, 'K095r4 Second', true), ($2, 'K095r4 Redeliver', true),
              ($3, 'K095r4 Dangle', true), ($4, 'K095r4 Other', true)`,
      COMPANIES,
    );

    const mandate = async (
      companyId: string, cents: number, status: string, code: string | null, extra = '',
    ) => {
      const r = await admin.query(
        `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, paystack_authorization_code, created_at)
         VALUES ($1, $2, $3, 'paystack', $4, now() ${extra}) RETURNING id`,
        [companyId, cents, status, code],
      );
      return r.rows[0].id as string;
    };

    // Checkout A activated two days ago; checkout B stayed open and its access
    // code was paid now. Neither request carries a mandate_id (pre-651 rows).
    secondActive = await mandate(SECOND_CO, 100000, 'active', 'AUTH_first_checkout', `- interval '2 days'`);
    secondPending = await mandate(SECOND_CO, 555555, 'pending', null);

    redeliverActive = await mandate(REDELIVER_CO, 100000, 'active', 'AUTH_redelivered');

    // The company has an active mandate of its own; the request under test
    // points at a row belonging to a DIFFERENT company.
    dangleOwnActive = await mandate(DANGLE_CO, 777777, 'active', 'AUTH_dangle_own');
    foreignMandate = await mandate(OTHER_CO, 888888, 'active', 'AUTH_foreign');

    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, mandate_id, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', NULL, $2, 100, 'ZAR', 'pending'),
              ($3, 'authorization', NULL, $4, 100, 'ZAR', 'pending'),
              ($5, 'authorization', $6, $7, 100, 'ZAR', 'completed')`,
      [SECOND_CO, SECOND_REF, REDELIVER_CO, REDELIVER_REF, DANGLE_CO, foreignMandate, DANGLE_REF],
    );

    ({ processEvent } = (await import(
      '../../src/modules/billing/services/paystackEventHandlers'
    )) as unknown as { processEvent: typeof processEvent });
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

  async function inWebhookTx(fn: () => Promise<void>) {
    const client: PoolClient = await admin.connect();
    let thrown: unknown = null;
    let committed = false;
    try {
      await client.query('BEGIN');
      await als.run({ client, claims: {} }, async () => {
        try { await fn(); } catch (err) { thrown = err; }
      });
      await client.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) { try { await client.query('ROLLBACK'); } catch { /* secondary */ } }
      client.release();
    }
    return { thrown, committed };
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

  it('labels a second paid checkout instead of reporting the already-active mandate as success', async () => {
    const { thrown, committed } = await inWebhookTx(() =>
      processEvent('charge.success', chargeSuccess(SECOND_REF, 'AUTH_second_checkout')),
    );

    expect(thrown).toBeNull();
    expect(committed).toBe(true);

    // The active mandate keeps its OWN authorization; the pending row this
    // reference paid for is untouched and nothing was silently overwritten.
    expect(await mandateRow(secondActive)).toEqual({ status: 'active', code: 'AUTH_first_checkout' });
    expect(await mandateRow(secondPending)).toEqual({ status: 'pending', code: null });

    expect(await requestRow(SECOND_REF)).toEqual({
      status: 'completed',
      failure_reason: 'authorisation_already_active_other_code',
    });
  });

  it('leaves a genuine redelivery of the SAME authorization unlabelled', async () => {
    const { thrown, committed } = await inWebhookTx(() =>
      processEvent('charge.success', chargeSuccess(REDELIVER_REF, 'AUTH_redelivered')),
    );

    expect(thrown).toBeNull();
    expect(committed).toBe(true);
    expect(await mandateRow(redeliverActive)).toEqual({ status: 'active', code: 'AUTH_redelivered' });
    expect(await requestRow(REDELIVER_REF)).toEqual({ status: 'completed', failure_reason: null });
  });

  it('answers no mandate for a request whose link no longer resolves, not the company newest row', async () => {
    const res = mockRes();
    const client: PoolClient = await admin.connect();
    let handlerError: unknown = null;
    let committed = false;
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: 'k095r4', companyId: DANGLE_CO, claims: {} }, async () => {
        try {
          await route(
            {
              method: 'GET', query: { ref: DANGLE_REF }, headers: {},
              companyId: DANGLE_CO, user: { id: 'k095r4' },
            } as unknown as NextApiRequest,
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
    expect(res.statusCode).toBe(200);
    const body = (res.body as {
      data: { status: string; mandateId: string | null; maxAmountCents?: number };
    }).data;

    // Before the fix this answered dangleOwnActive: 'active', ceiling 777777,
    // for a reference that authorised neither.
    expect(body.mandateId).toBeNull();
    expect(body.status).toBe('pending');
    expect(body.maxAmountCents).toBeUndefined();
    expect(await mandateRow(dangleOwnActive)).toEqual({ status: 'active', code: 'AUTH_dangle_own' });
    expect(await mandateRow(foreignMandate)).toEqual({ status: 'active', code: 'AUTH_foreign' });
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
