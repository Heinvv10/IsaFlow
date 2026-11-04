/**
 * Budgets P5-2 review round 2 (R3 + security): the bill modes of POST /api/accounting/budgets/remaining,
 * through the real route (withAuth → app_user): the body shapes, a single bill not this company's (404), a
 * bulk list that skips a missing bill and reports a bill whose budget cannot be read as `unavailable`
 * (the rest still answer), a cost-centre pick approve would refuse (400 single), the 50-bill cap, the
 * write-role gate, and the rate limit charged per bill. Fixture route: isaflow_schema_fixture
 * (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, dropBillFixture, makeBill, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
const viewer = crypto.randomUUID();
const limited = crypto.randomUUID();
const URL = '/api/accounting/budgets/remaining';

beforeAll(async () => {
  f = await seedBillFixture(pool, 'preview');
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true), ($3, $4, 'admin', true)",
    [viewer, `${viewer}@test.local`, limited, `${limited}@test.local`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer'), ($1, $3, 'admin')", [f.co, viewer, limited]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[viewer, limited, f.owner, f.manager].map((u) => `budget-remaining:${u}`)]);
    await dropBillFixture(pool, f);
    await pool.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[viewer, limited]]);
  } finally {
    await pool.end();
  }
}, 60_000);

const post = (body: unknown, user = f.owner) => callRoute(remainingRoute as never, f, user, URL, body);
const ftBill = (amount: number) => makeBill(pool, f, [{ acct: f.acc.opex, amount, cc1: f.cc.FT }], { date: '2026-06-15' });
/** A bill whose legacy cost-centre pick names no centre of this company: approve refuses it (400). */
async function foreignPickBill(): Promise<string> {
  const id = await ftBill(10);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('UPDATE supplier_invoice_items SET cost_center_id = $2, cc1_id = NULL WHERE supplier_invoice_id = $1', [id, crypto.randomUUID()]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  return id;
}

describe('bill modes', () => {
  it('body shapes: one of the two keys only, uuids only (422, the zod answer)', async () => {
    const id = await ftBill(10);
    for (const body of [{ supplierInvoiceId: id, supplierInvoiceIds: [id] }, { supplierInvoiceId: 'x' }, { supplierInvoiceIds: [] },
      { supplierInvoiceId: id, extra: 1 }]) {
      expect((await post(body)).statusCode, JSON.stringify(body)).toBe(422);
    }
  });

  it('single: the preview of a bill over budget; 404 for a bill not this company\'s', async () => {
    await setPolicy(pool, f, 'warn');
    const r = await post({ supplierInvoiceId: await ftBill(1500) });
    expect(r.statusCode).toBe(200);
    expect(r.body.data).toMatchObject({ policy: 'warn', checks: true, overCount: 1 });
    expect((await post({ supplierInvoiceId: crypto.randomUUID() })).statusCode).toBe(404);
  });

  it('single: a cost-centre pick approve would refuse is a 400', async () => {
    const r = await post({ supplierInvoiceId: await foreignPickBill() });
    expect(r.statusCode).toBe(400);
  });

  it('bulk: a missing bill is left out; an unreadable one is "unavailable"; the rest answer', async () => {
    await setPolicy(pool, f, 'block');
    const over = await ftBill(5000);
    const fits = await ftBill(10);
    const bad = await foreignPickBill();
    const r = await post({ supplierInvoiceIds: [over, crypto.randomUUID(), bad, fits] });
    expect(r.statusCode).toBe(200);
    const data = r.body.data as { policy: string; overBills: number; bills: Array<Record<string, unknown>> };
    expect(data.policy).toBe('block');
    expect(data.overBills).toBe(1);
    expect(data.bills.map((b) => b.invoiceId)).toEqual([over, bad, fits]);
    expect(data.bills[1]).toMatchObject({ invoiceId: bad, unavailable: expect.any(String) });
  });

  it('bulk: at most 50 bills (400 before anything is read)', async () => {
    const ids = Array.from({ length: 51 }, () => crypto.randomUUID());
    expect((await post({ supplierInvoiceIds: ids })).statusCode).toBe(400);
  });

  it('write roles only: a viewer is refused', async () => {
    expect((await post({ supplierInvoiceId: await ftBill(10) }, viewer)).statusCode).toBe(403);
  });

  it('the rate limit is charged per bill: 50 + 50 pass, the third 50 is over 120 a minute', async () => {
    const fifty = () => ({ supplierInvoiceIds: Array.from({ length: 50 }, () => crypto.randomUUID()) });
    expect((await post(fifty(), limited)).statusCode).toBe(200);
    expect((await post(fifty(), limited)).statusCode).toBe(200);
    expect((await post(fifty(), limited)).statusCode).toBe(429);
  });
});
