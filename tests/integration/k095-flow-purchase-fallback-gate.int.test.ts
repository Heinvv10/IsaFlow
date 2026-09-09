// tests/integration/k095-flow-purchase-fallback-gate.int.test.ts
//
// K-095 adjacent cases for the unpaid-fallback gate on
// `POST /api/billing/flows/purchase`:
//
//   1. The fallback still works where it is switched on deliberately outside
//      production — closing the hole must not break local/pilot deployments.
//   2. NODE_ENV=production overrides the opt-in flag: even with the flag set,
//      a production deployment with no gateway secret refuses.
//   3. A refusal for one company leaves another tenant's wallet alone.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const PLAN = randomUUID();
const BUNDLE = randomUUID();
const BUNDLE_FLOWS = 250;
const BUNDLE_PRICE_CENTS = 19900;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('K-095 unpaid fallback gate', () => {
  let admin: Pool;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
  let savedKey: string | undefined;
  let savedFlag: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K095 Gate Fixture', true), ($2, 'K095 Other Tenant', true)`,
      [COMPANY, OTHER_COMPANY],
    );
    await admin.query(
      `INSERT INTO plans (id, code, name, monthly_price_cents, annual_price_cents, is_active)
       VALUES ($1, 'payg', 'Pay As You Go', 0, 0, true)`,
      [PLAN],
    );
    await admin.query(
      `INSERT INTO subscriptions (company_id, plan_id, status) VALUES ($1, $2, 'active'), ($3, $2, 'active')`,
      [COMPANY, PLAN, OTHER_COMPANY],
    );
    await admin.query(
      `INSERT INTO flow_bundles (id, name, flows, price_cents, is_active, display_order)
       VALUES ($1, 'K095 Gate Bundle', $2, $3, true, 0)`,
      [BUNDLE, BUNDLE_FLOWS, BUNDLE_PRICE_CENTS],
    );

    savedKey = process.env.PAYSTACK_SECRET_KEY;
    savedFlag = process.env.ALLOW_UNPAID_FLOW_PURCHASE;
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.PAYSTACK_SECRET_KEY;

    route = (await import('../../pages/api/billing/flows/purchase'))
      .default as unknown as typeof route;
  }, 60000);

  afterAll(async () => {
    if (savedKey !== undefined) process.env.PAYSTACK_SECRET_KEY = savedKey;
    if (savedFlag === undefined) delete process.env.ALLOW_UNPAID_FLOW_PURCHASE;
    else process.env.ALLOW_UNPAID_FLOW_PURCHASE = savedFlag;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    if (!admin) return;
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM flow_ledger WHERE company_id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
      await c.query('DELETE FROM flow_purchases WHERE company_id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
      await c.query('DELETE FROM flow_wallet WHERE company_id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
      await c.query('DELETE FROM flow_bundles WHERE id = $1', [BUNDLE]);
      await c.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
      await c.query('DELETE FROM companies WHERE id = ANY($1)', [[COMPANY, OTHER_COMPANY]]);
      await c.query('DELETE FROM plans WHERE id = $1', [PLAN]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await admin.end();
  });

  async function purchase(companyId: string) {
    const res = mockRes();
    await route(
      {
        method: 'POST',
        query: {},
        headers: {},
        body: { bundleId: BUNDLE },
        companyId,
        user: { id: 'k095-gate', email: 'k095-gate@example.invalid' },
      } as unknown as NextApiRequest,
      res,
    );
    return res;
  }

  async function balance(companyId: string) {
    const w = await admin.query('SELECT balance_flows FROM flow_wallet WHERE company_id = $1', [companyId]);
    return Number(w.rows[0]?.balance_flows ?? 0);
  }

  it('production refuses even when the opt-in flag is set', async () => {
    process.env.ALLOW_UNPAID_FLOW_PURCHASE = 'true';
    process.env.NODE_ENV = 'production';

    const res = await purchase(COMPANY);

    expect(res.statusCode).toBe(503);
    expect(await balance(COMPANY)).toBe(0);
    // The other tenant is not touched by anything this request did.
    expect(await balance(OTHER_COMPANY)).toBe(0);
  });

  it('the opt-in flag outside production still credits, so pilots keep working', async () => {
    process.env.ALLOW_UNPAID_FLOW_PURCHASE = 'true';
    process.env.NODE_ENV = 'development';

    const res = await purchase(COMPANY);

    expect(res.statusCode).toBe(201);
    expect(await balance(COMPANY)).toBe(BUNDLE_FLOWS);
    expect(await balance(OTHER_COMPANY)).toBe(0);

    const purchases = await admin.query(
      `SELECT status, payment_method FROM flow_purchases WHERE company_id = $1`,
      [COMPANY],
    );
    expect(purchases.rows).toHaveLength(1);
    expect(purchases.rows[0].status).toBe('succeeded');
    expect(purchases.rows[0].payment_method).toBe('admin_recorded');
  });

  it('a malformed flag value is not an opt-in', async () => {
    process.env.ALLOW_UNPAID_FLOW_PURCHASE = '1';
    process.env.NODE_ENV = 'development';

    const before = await balance(OTHER_COMPANY);
    const res = await purchase(OTHER_COMPANY);

    expect(res.statusCode).toBe(503);
    expect(await balance(OTHER_COMPANY)).toBe(before);
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
