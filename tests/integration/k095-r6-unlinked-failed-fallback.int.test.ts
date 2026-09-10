// tests/integration/k095-r6-unlinked-failed-fallback.int.test.ts
//
// Round-6 blind review of 5c6e1a50c, LOW-1.
//
// A payment request written before migration 651 carries no mandate_id. When
// resolveAuthorisedMandate finds no pending or active row for the company, the
// verify route used to run a SECOND, unlinked lookup that also admitted
// `status = 'failed'` — and with no failure_reason recorded, the `own` gate let
// that row straight into the response. The payer was then shown the id, bank,
// card and ceiling of a mandate row some OTHER checkout created: the exact
// mis-attribution migration 651 exists to retire, in the one shape the gate did
// not cover.
//
// The route now reads only the mandate this request actually resolved, and
// takes the failure signal from THIS reference's own payment request row.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: vi.fn(),
}));

const DATABASE_URL = process.env.DATABASE_URL;

const FAILED_CO = randomUUID();  // pre-651 request, only another checkout's FAILED row survives
const OPEN_CO = randomUUID();    // same, but the request itself completed
const OTHER_CO = randomUUID();   // a second tenant, for the cross-tenant probe
const LIVE_CO = randomUUID();    // pre-651 request whose company still has an ACTIVE row
const COMPANIES = [FAILED_CO, OPEN_CO, OTHER_CO, LIVE_CO];

const FAILED_REF = `k095r6f_${randomUUID().slice(0, 8)}`;
const OPEN_REF = `k095r6o_${randomUUID().slice(0, 8)}`;
const LIVE_REF = `k095r6l_${randomUUID().slice(0, 8)}`;

let failedOtherMandate: string;
let openOtherMandate: string;
let liveMandate: string;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-095 r6 an unlinked pre-651 request never names another checkout row', () => {
  let admin: Pool;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 5 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active)
       VALUES ($1, 'K095r6 Failed', true), ($2, 'K095r6 Open', true),
              ($3, 'K095r6 Other', true), ($4, 'K095r6 Live', true)`,
      COMPANIES,
    );

    const mandate = async (companyId: string, cents: number, status: string) => {
      const r = await admin.query(
        `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway,
           paystack_authorization_code, card_last4, card_brand, bank_name)
         VALUES ($1, $2, $3, 'paystack', 'AUTH_k095r6_other', '4242', 'visa', 'Someone Else Bank')
         RETURNING id`,
        [companyId, cents, status],
      );
      return r.rows[0].id as string;
    };

    // The only surviving paystack row for these companies belongs to a DIFFERENT
    // checkout — it failed, so resolveAuthorisedMandate (pending/active only)
    // resolves nothing for the reference under test.
    failedOtherMandate = await mandate(FAILED_CO, 111111, 'failed');
    openOtherMandate = await mandate(OPEN_CO, 222222, 'failed');
    liveMandate = await mandate(LIVE_CO, 333333, 'active');

    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, mandate_id, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', NULL, $2, 100, 'ZAR', 'failed'),
              ($3, 'authorization', NULL, $4, 100, 'ZAR', 'completed'),
              ($5, 'authorization', NULL, $6, 100, 'ZAR', 'completed')`,
      [FAILED_CO, FAILED_REF, OPEN_CO, OPEN_REF, LIVE_CO, LIVE_REF],
    );

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

  async function runVerify(companyId: string, ref: string) {
    const res = mockRes();
    const client: PoolClient = await admin.connect();
    let handlerError: unknown = null;
    let committed = false;
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: 'k095r6', companyId, claims: {} }, async () => {
        try {
          await route(
            { method: 'GET', query: { ref }, headers: {}, companyId, user: { id: 'k095r6' } } as unknown as NextApiRequest,
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
    return {
      statusCode: res.statusCode,
      data: (res.body as {
        data?: {
          status: string; mandateId: string | null; failureReason?: string;
          maxAmountCents?: number; cardLast4?: string; cardBrand?: string; bankName?: string;
        };
      }).data,
    };
  }

  it('reports the failure from its OWN request row, naming no mandate at all', async () => {
    const { data } = await runVerify(FAILED_CO, FAILED_REF);

    // Still failed — the signal comes from paystack_payment_requests.status,
    // which is this reference's own row...
    expect(data!.status).toBe('failed');
    // ...and the other checkout's failed row is not identified in any field.
    expect(data!.mandateId).toBeNull();
    expect(data!.maxAmountCents).toBeUndefined();
    expect(data!.cardLast4).toBeUndefined();
    expect(data!.cardBrand).toBeUndefined();
    expect(data!.bankName).toBeUndefined();
    // Read-only: the other checkout's row is untouched.
    expect(await mandateStatus(failedOtherMandate)).toBe('failed');
  });

  it('a completed request that resolved nothing stays pending rather than borrowing a failure', async () => {
    const { data } = await runVerify(OPEN_CO, OPEN_REF);

    // Nothing on this reference says it failed, and the only row available
    // belongs to another checkout, so the route must not adopt its status.
    expect(data!.status).toBe('pending');
    expect(data!.mandateId).toBeNull();
    expect(data!.maxAmountCents).toBeUndefined();
    expect(data!.bankName).toBeUndefined();
    expect(await mandateStatus(openOtherMandate)).toBe('failed');
  });

  it('another tenant cannot read the reference at all', async () => {
    const { statusCode, data } = await runVerify(OTHER_CO, FAILED_REF);

    expect(statusCode).toBe(404);
    expect(data).toBeUndefined();
  });

  it('the pre-651 newest-first resolution of a LIVE row still works', async () => {
    const { data } = await runVerify(LIVE_CO, LIVE_REF);

    // The unlinked fallback that survives is the one in resolveAuthorisedMandate
    // (pending/active). Removing the second, failed-admitting lookup must not
    // break continuity for pre-651 checkouts that actually succeeded.
    expect(data!.status).toBe('active');
    expect(data!.mandateId).toBe(liveMandate);
    expect(data!.maxAmountCents).toBe(333333);
  });

  async function mandateStatus(id: string) {
    const { rows } = await admin.query('SELECT status FROM subscription_mandates WHERE id = $1', [id]);
    return (rows[0] as { status: string }).status;
  }
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
