// tests/integration/k096-mandate-link-persisted.int.test.ts
//
// MEDIUM-1 from the blind review of fb63f304. The first fix said the write
// targeted "the mandate this reference resolved to", but nothing in the schema
// resolved a reference to a mandate: create.ts passed the mandate id only in
// the Paystack metadata, which the verify path cannot read back. What the
// LEFT JOIN actually picked was the company's newest pending paystack mandate,
// so verifying an OLDER reference activated a NEWER mandate — carrying a
// max_amount_cents ceiling the customer never authorised on that reference.
//
// Migration 651 adds paystack_payment_requests.mandate_id. Cases:
//   1. create.ts persists the link.
//   2. verify.ts activates the LINKED mandate even when it is not the newest
//      pending one — the case the heuristic gets wrong.
//   3. A link pointing at another tenant's mandate activates nothing.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withRole: () => (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));

const initializeTransaction = vi.fn();
const verifyTransaction = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: (a: unknown) => initializeTransaction(a),
  verifyTransaction: (r: string) => verifyTransaction(r),
}));

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();
const CREATE_REF = `k096c_${randomUUID().slice(0, 8)}`;
const OLD_REF = `k096o_${randomUUID().slice(0, 8)}`;
const CROSS_REF = `k096x_${randomUUID().slice(0, 8)}`;

let olderMandate: string;
let newerMandate: string;
let foreignMandate: string;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-096 reference-to-mandate link', () => {
  let admin: Pool;
  let createRoute: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
  let verifyRoute: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active)
       VALUES ($1, 'K096 Link Fixture', true), ($2, 'K096 Link Other Tenant', true)`,
      [COMPANY, OTHER_COMPANY],
    );
    await admin.query(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'K096', 'Link User')`,
      [USER, `k096-link-${USER.slice(0, 8)}@example.invalid`],
    );

    // Two pending mandates. The reference under test belongs to the OLDER one,
    // which is exactly what the newest-first heuristic gets wrong.
    const a = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 150000, 'pending', 'paystack', now() - interval '2 days') RETURNING id`,
      [COMPANY],
    );
    olderMandate = a.rows[0].id;
    const b = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 950000, 'pending', 'paystack', now()) RETURNING id`,
      [COMPANY],
    );
    newerMandate = b.rows[0].id;
    const c = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 250000, 'pending', 'paystack', now()) RETURNING id`,
      [OTHER_COMPANY],
    );
    foreignMandate = c.rows[0].id;

    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, mandate_id, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', $2, $3, 100, 'ZAR', 'pending'),
              ($1, 'authorization', $4, $5, 100, 'ZAR', 'pending')`,
      [COMPANY, olderMandate, OLD_REF, foreignMandate, CROSS_REF],
    );

    createRoute = (await import('../../pages/api/billing/paystack/mandate/create'))
      .default as unknown as typeof createRoute;
    verifyRoute = (await import('../../pages/api/billing/paystack/mandate/verify'))
      .default as unknown as typeof verifyRoute;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM paystack_payment_requests WHERE company_id = ANY($1)', [
      [COMPANY, OTHER_COMPANY],
    ]);
    await admin.query('DELETE FROM subscription_mandates WHERE company_id = ANY($1)', [
      [COMPANY, OTHER_COMPANY],
    ]);
    await admin.query('DELETE FROM users WHERE id = $1', [USER]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
    await admin.end();
  });

  /** Run a handler the way withAuth does: inside one request transaction. */
  async function inRequestTx(
    route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
    req: Record<string, unknown>,
  ) {
    const res = mockRes();
    const client: PoolClient = await admin.connect();
    try {
      await client.query('BEGIN');
      await als.run({ client } as never, async () => {
        await route(req as unknown as NextApiRequest, res);
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return res;
  }

  it('create.ts persists the mandate the checkout was started for', async () => {
    initializeTransaction.mockResolvedValueOnce({
      reference: CREATE_REF,
      accessCode: 'ACCESS_k096c',
      authorizationUrl: 'https://checkout.paystack.test/k096c',
    });

    const res = await inRequestTx(createRoute, {
      method: 'POST',
      query: {},
      headers: {},
      body: { maxAmountCents: 400000 },
      companyId: OTHER_COMPANY,
      user: { id: USER, email: 'k096-link@example.invalid' },
    });
    expect(res.statusCode).toBe(200);

    const pr = await admin.query(
      `SELECT mandate_id FROM paystack_payment_requests WHERE paystack_reference = $1`,
      [CREATE_REF],
    );
    expect(pr.rows).toHaveLength(1);
    const linked = pr.rows[0].mandate_id;
    expect(linked).not.toBeNull();

    // And it is the mandate this very call created, not some older row.
    const m = await admin.query(
      `SELECT company_id, max_amount_cents, status FROM subscription_mandates WHERE id = $1`,
      [linked],
    );
    expect(m.rows[0].company_id).toBe(OTHER_COMPANY);
    expect(Number(m.rows[0].max_amount_cents)).toBe(400000);
    expect(m.rows[0].status).toBe('pending');
  });

  it('verify activates the LINKED mandate, not the newest pending one', async () => {
    verifyTransaction.mockResolvedValueOnce({
      status: 'success',
      id: 515151,
      customer: { customerCode: 'CUS_k096o' },
      authorization: {
        authorizationCode: 'AUTH_k096o',
        last4: '1111',
        brand: 'visa',
        expMonth: '01',
        expYear: '2031',
        bank: 'Test Bank',
      },
    });

    const res = await inRequestTx(verifyRoute, {
      method: 'GET',
      query: { ref: OLD_REF },
      headers: {},
      companyId: COMPANY,
      user: { id: USER, email: 'k096-link@example.invalid' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await admin.query(
      `SELECT id, status, paystack_authorization_code, max_amount_cents
       FROM subscription_mandates WHERE company_id = $1`,
      [COMPANY],
    );
    const byId = new Map(rows.rows.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(olderMandate)!.status).toBe('active');
    expect(byId.get(olderMandate)!.paystack_authorization_code).toBe('AUTH_k096o');
    // The ceiling that went live is the one authorised on THIS reference.
    expect(Number(byId.get(olderMandate)!.max_amount_cents)).toBe(150000);
    expect(byId.get(newerMandate)!.status).toBe('pending');
    expect(byId.get(newerMandate)!.paystack_authorization_code).toBeNull();
  });

  it('a link pointing at another tenant’s mandate activates nothing', async () => {
    verifyTransaction.mockResolvedValueOnce({
      status: 'success',
      id: 626262,
      customer: { customerCode: 'CUS_k096x' },
      authorization: { authorizationCode: 'AUTH_k096x', last4: '2222', brand: 'visa' },
    });

    const res = await inRequestTx(verifyRoute, {
      method: 'GET',
      query: { ref: CROSS_REF },
      headers: {},
      companyId: COMPANY,
      user: { id: USER, email: 'k096-link@example.invalid' },
    });
    expect(res.statusCode).toBe(200);

    const foreign = await admin.query(
      `SELECT status, paystack_authorization_code FROM subscription_mandates WHERE id = $1`,
      [foreignMandate],
    );
    expect(foreign.rows[0].status).toBe('pending');
    expect(foreign.rows[0].paystack_authorization_code).toBeNull();
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
