// tests/integration/k095-flow-purchase-fails-open-without-paystack.int.test.ts
//
// K-095. `POST /api/billing/flows/purchase` decides whether to take payment by
// reading an environment variable:
//
//     function paystackConfigured() { return Boolean(process.env.PAYSTACK_SECRET_KEY); }
//     if (!paystackConfigured()) { ...startBundlePurchase...; completeBundlePurchase(...) }
//
// When the key is absent the route credits the wallet immediately and returns
// 201. Nothing else gates that branch — not NODE_ENV, not a plan flag, not an
// admin role. Any authenticated user on a PAYG plan can buy Flows for nothing,
// and the purchase is written as `admin_recorded` so it does not look
// anomalous afterwards. A missing or rotated-out secret is a configuration
// state, not an impossible one, and the failure is silent in both directions:
// no error is raised and the wallet is credited.
//
// This test drives the real route with the key unset and asserts the wallet is
// NOT credited without a payment.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = randomUUID();
const PLAN = randomUUID();
const BUNDLE = randomUUID();
const BUNDLE_FLOWS = 500;
const BUNDLE_PRICE_CENTS = 49900;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-095 Flow bundle purchase must not credit without payment', () => {
  let admin: Pool;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
  let savedKey: string | undefined;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K095 Flows Fixture', true)`,
      [COMPANY],
    );
    await admin.query(
      `INSERT INTO plans (id, code, name, monthly_price_cents, annual_price_cents, is_active)
       VALUES ($1, $2, 'Pay As You Go', 0, 0, true)`,
      [PLAN, `payg`],
    );
    await admin.query(
      `INSERT INTO subscriptions (company_id, plan_id, status) VALUES ($1, $2, 'active')`,
      [COMPANY, PLAN],
    );
    await admin.query(
      `INSERT INTO flow_bundles (id, name, flows, price_cents, is_active, display_order)
       VALUES ($1, 'K095 Bundle', $2, $3, true, 0)`,
      [BUNDLE, BUNDLE_FLOWS, BUNDLE_PRICE_CENTS],
    );

    savedKey = process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_SECRET_KEY;

    route = (await import('../../pages/api/billing/flows/purchase'))
      .default as unknown as typeof route;
  }, 60000);

  afterAll(async () => {
    if (savedKey !== undefined) process.env.PAYSTACK_SECRET_KEY = savedKey;
    if (!admin) return;
    const c = await admin.connect();
    try {
      // `flow_ledger` carries an append-only trigger that refuses DELETE, and
      // it also refuses the ON DELETE CASCADE from `companies`. Suppressing
      // triggers for the teardown is the only way to leave the shared fixture
      // database as it was found.
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM flow_ledger WHERE company_id = $1', [COMPANY]);
      await c.query('DELETE FROM flow_purchases WHERE company_id = $1', [COMPANY]);
      await c.query('DELETE FROM flow_wallet WHERE company_id = $1', [COMPANY]);
      await c.query('DELETE FROM flow_bundles WHERE id = $1', [BUNDLE]);
      await c.query('DELETE FROM subscriptions WHERE company_id = $1', [COMPANY]);
      await c.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
      await c.query('DELETE FROM plans WHERE id = $1', [PLAN]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await admin.end();
  });

  it('does not credit the wallet when no payment gateway is configured', async () => {
    expect(process.env.PAYSTACK_SECRET_KEY).toBeUndefined();

    const res = mockRes();
    await route(
      {
        method: 'POST',
        query: {},
        headers: {},
        body: { bundleId: BUNDLE },
        companyId: COMPANY,
        user: { id: 'k095', email: 'k095@example.invalid' },
      } as unknown as NextApiRequest,
      res,
    );

    const wallet = await admin.query(
      'SELECT balance_flows FROM flow_wallet WHERE company_id = $1',
      [COMPANY],
    );
    const balance = Number(wallet.rows[0]?.balance_flows ?? 0);

    const purchases = await admin.query(
      `SELECT status, payment_method, price_cents FROM flow_purchases WHERE company_id = $1`,
      [COMPANY],
    );

    // Today: 201, balance 500, one 'succeeded' / 'admin_recorded' purchase at
    // R499.00 that nobody paid.
    expect(balance).toBe(0);
    expect(purchases.rows.filter((r) => r.status === 'succeeded')).toHaveLength(0);
    expect(res.statusCode).not.toBe(201);
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
