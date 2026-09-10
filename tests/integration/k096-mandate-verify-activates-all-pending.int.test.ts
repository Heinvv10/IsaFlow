// tests/integration/k096-mandate-verify-activates-all-pending.int.test.ts
//
// K-096. `pages/api/billing/paystack/mandate/verify.ts` resolves ONE mandate
// through its LEFT JOIN (`row.mandate_id`) and then promotes it with
//
//     UPDATE subscription_mandates SET status = 'active' ...
//      WHERE company_id = $1 AND status = 'pending' AND gateway = 'paystack'
//
// which is every pending mandate for the company, not the one the reference
// belongs to. A company accumulates pending mandates whenever a checkout is
// abandoned and retried — the start path writes a new pending row each time.
//
// Migration 429 defines `ux_sub_mandates_company_active` UNIQUE (company_id)
// WHERE status = 'active', so the multi-row UPDATE does not leave several
// active mandates: it raises 23505 mid-statement. The route's own catch logs
// that at warn level and continues, but withAuth has already opened a
// transaction on this connection, so the failed statement leaves it aborted.
// Every later query — including the route's own "re-read the canonical state"
// SELECT — raises 25P02, and the whole request, the completed payment request
// included, rolls back.
//
// The test runs the real route inside a real request transaction, exactly as
// withAuth does, and asserts the mandate the reference names is activated and
// the transaction commits.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));

// Paystack says the authorisation succeeded. No network.
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: vi.fn(async () => ({
    status: 'success',
    id: 987654,
    authorization: {
      authorizationCode: 'AUTH_k096',
      last4: '4242',
      brand: 'visa',
      expMonth: '12',
      expYear: '2030',
      bank: 'Test Bank',
    },
    customer: { customerCode: 'CUS_k096' },
  })),
}));

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = randomUUID();
const REF = `k096_${randomUUID().slice(0, 8)}`;

let abandonedMandate: string; // created first, checkout abandoned
let currentMandate: string;   // created for REF, the one being authorised

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-096 mandate verify must activate only the mandate it authorised', () => {
  let admin: Pool;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K096 Mandate Fixture', true)`,
      [COMPANY],
    );

    // Two pending mandates: an abandoned checkout, then the retry.
    const a = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 500000, 'pending', 'paystack', now() - interval '1 day') RETURNING id`,
      [COMPANY],
    );
    abandonedMandate = a.rows[0].id;

    const b = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 500000, 'pending', 'paystack', now()) RETURNING id`,
      [COMPANY],
    );
    currentMandate = b.rows[0].id;

    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', $2, 500000, 'ZAR', 'pending')`,
      [COMPANY, REF],
    );

    route = (await import('../../pages/api/billing/paystack/mandate/verify'))
      .default as unknown as typeof route;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM paystack_payment_requests WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM subscription_mandates WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('activates one mandate and commits the request transaction', async () => {
    const res = mockRes();
    const client: PoolClient = await admin.connect();
    let committed = false;
    let handlerError: unknown = null;

    try {
      // withAuth's shape: one transaction per request, shared through ALS.
      await client.query('BEGIN');
      await als.run(
        { client, userId: 'k096', companyId: COMPANY, claims: {} },
        async () => {
          try {
            await route(
              {
                method: 'GET',
                query: { ref: REF },
                headers: {},
                companyId: COMPANY,
                user: { id: 'k096' },
              } as unknown as NextApiRequest,
              res,
            );
          } catch (err) {
            handlerError = err;
          }
        },
      );
      await client.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) { try { await client.query('ROLLBACK'); } catch { /* secondary */ } }
      client.release();
    }

    // The route must not blow up on the poisoned transaction.
    expect(handlerError).toBeNull();
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { status: string } }).data.status).toBe('active');

    const { rows } = await admin.query(
      `SELECT id, status FROM subscription_mandates WHERE company_id = $1 ORDER BY created_at`,
      [COMPANY],
    );
    const byId = new Map(rows.map((r) => [r.id as string, r.status as string]));

    // Exactly the mandate this reference authorised.
    expect(byId.get(currentMandate)).toBe('active');
    // The abandoned one is untouched, not swept into the same promotion.
    expect(byId.get(abandonedMandate)).toBe('pending');

    const pr = await admin.query(
      `SELECT status FROM paystack_payment_requests WHERE paystack_reference = $1`,
      [REF],
    );
    expect(pr.rows[0].status).toBe('completed');
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
