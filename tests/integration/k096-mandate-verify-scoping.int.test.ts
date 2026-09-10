// tests/integration/k096-mandate-verify-scoping.int.test.ts
//
// K-096 adjacent cases for scoping the mandate writes in
// `GET /api/billing/paystack/mandate/verify`:
//
//   1. The failed/abandoned branch marks only the mandate the reference
//      resolved to, not every pending mandate the company has — a user
//      mid-way through a second authorisation must not be failed by a
//      stale abandoned one.
//   2. Another tenant's pending mandate is never touched.
//   3. Re-running the same reference after it has completed is a no-op that
//      still returns the canonical state (the retry case).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));

const verifyTransaction = vi.fn();
vi.mock('@/modules/billing/services/paystackClient', () => ({
  verifyTransaction: (ref: string) => verifyTransaction(ref),
}));

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const FAILED_REF = `k096f_${randomUUID().slice(0, 8)}`;
const DONE_REF = `k096d_${randomUUID().slice(0, 8)}`;

let abandonedMandate: string;
let currentMandate: string;
let otherTenantMandate: string;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-096 mandate verify write scoping', () => {
  let admin: Pool;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K096 Scoping Fixture', true), ($2, 'K096 Other Tenant', true)`,
      [COMPANY, OTHER_COMPANY],
    );

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

    const c = await admin.query(
      `INSERT INTO subscription_mandates (company_id, max_amount_cents, status, gateway, created_at)
       VALUES ($1, 500000, 'pending', 'paystack', now()) RETURNING id`,
      [OTHER_COMPANY],
    );
    otherTenantMandate = c.rows[0].id;

    await admin.query(
      `INSERT INTO paystack_payment_requests
         (company_id, purpose, paystack_reference, amount_cents, currency, status)
       VALUES ($1, 'authorization', $2, 500000, 'ZAR', 'pending'),
              ($1, 'authorization', $3, 500000, 'ZAR', 'completed')`,
      [COMPANY, FAILED_REF, DONE_REF],
    );

    route = (await import('../../pages/api/billing/paystack/mandate/verify'))
      .default as unknown as typeof route;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM paystack_payment_requests WHERE company_id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
    await admin.query('DELETE FROM subscription_mandates WHERE company_id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
    await admin.end();
  });

  async function runInRequestTx(companyId: string, ref: string) {
    const res = mockRes();
    const client: PoolClient = await admin.connect();
    let committed = false;
    let handlerError: unknown = null;
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: 'k096', companyId, claims: {} }, async () => {
        try {
          await route(
            { method: 'GET', query: { ref }, headers: {}, companyId, user: { id: 'k096' } } as unknown as NextApiRequest,
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
    return { res, handlerError };
  }

  async function statuses() {
    const { rows } = await admin.query(
      `SELECT id, status FROM subscription_mandates WHERE company_id = ANY($1)`,
      [[COMPANY, OTHER_COMPANY]],
    );
    return new Map(rows.map((r) => [r.id as string, r.status as string]));
  }

  it('an abandoned authorisation fails only its own mandate', async () => {
    verifyTransaction.mockResolvedValueOnce({ status: 'abandoned' });

    const { res, handlerError } = await runInRequestTx(COMPANY, FAILED_REF);

    expect(handlerError).toBeNull();
    expect(res.statusCode).toBe(200);

    const byId = await statuses();
    expect(byId.get(currentMandate)).toBe('failed');
    // The older pending mandate is not swept into the same failure.
    expect(byId.get(abandonedMandate)).toBe('pending');
    // Another tenant's mandate is untouched.
    expect(byId.get(otherTenantMandate)).toBe('pending');

    const pr = await admin.query(
      `SELECT status FROM paystack_payment_requests WHERE paystack_reference = $1`,
      [FAILED_REF],
    );
    expect(pr.rows[0].status).toBe('failed');
  });

  it('a reference already completed is not re-verified and writes nothing', async () => {
    verifyTransaction.mockClear();
    const before = await statuses();

    const { res, handlerError } = await runInRequestTx(COMPANY, DONE_REF);

    expect(handlerError).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(verifyTransaction).not.toHaveBeenCalled();
    expect(await statuses()).toEqual(before);
  });

  it("a reference belonging to another company is not found", async () => {
    verifyTransaction.mockClear();
    const before = await statuses();

    const { res, handlerError } = await runInRequestTx(OTHER_COMPANY, FAILED_REF);

    expect(handlerError).toBeNull();
    expect(res.statusCode).toBe(404);
    expect(verifyTransaction).not.toHaveBeenCalled();
    expect(await statuses()).toEqual(before);
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
