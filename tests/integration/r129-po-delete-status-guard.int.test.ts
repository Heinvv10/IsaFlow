/**
 * R-129 — DELETE /api/accounting/purchase-orders/[id] read the status, then
 * deleted by id + company_id only. This test opens that window
 * deterministically: straight after the handler's first status read, another
 * connection submits the order, the way a concurrent submit would. The
 * submitted order must survive, with its lines.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

const hooks = vi.hoisted(() => ({ afterFirstStatusRead: null as null | (() => Promise<void>) }));

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
// Pass every statement through to the real database; after the first read of
// purchase_orders (the status check), run the hook once.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const rows = await realSql(strings, ...values);
    const text = strings.join('?');
    const hook = hooks.afterFirstStatusRead;
    if (hook && /^\s*SELECT/.test(text) && text.includes('FROM purchase_orders')) {
      hooks.afterFirstStatusRead = null;
      await hook();
    }
    return rows;
  };
  return { ...real, sql };
});

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
let route: Route;

function mockRes() {
  const res = {
    statusCode: 200, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    send(p: unknown) { this.body = p; return this; },
    end(p?: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

async function del(id: string, companyId: string) {
  const res = mockRes();
  await route({ method: 'DELETE', query: { id }, body: {}, headers: {}, companyId, user: { id: USER } } as unknown as NextApiRequest, res);
  return res;
}

async function seedPo(companyId: string, status: string): Promise<string> {
  const supplier = (await admin.query(
    `INSERT INTO suppliers (company_id,name,is_active) VALUES ($1,'R129 Supplier',true) RETURNING id`, [companyId])).rows[0].id;
  const po = (await admin.query(
    `INSERT INTO purchase_orders (company_id,po_number,supplier_id,status)
     VALUES ($1,$2,$3,$4) RETURNING id`, [companyId, `R129-${randomUUID().slice(0, 8)}`, supplier, status])).rows[0].id;
  await admin.query(
    `INSERT INTO po_items (purchase_order_id,description,quantity,unit_price,line_total,tax_amount,sort_order)
     VALUES ($1,'R129 line',1,100,100,15,0)`, [po]);
  return po;
}
const statusOf = async (id: string) =>
  (await admin.query('SELECT status FROM purchase_orders WHERE id = $1', [id])).rows[0]?.status ?? null;
const itemCount = async (id: string) =>
  Number((await admin.query('SELECT COUNT(*) FROM po_items WHERE purchase_order_id = $1', [id])).rows[0].count);

describeIfDb('R-129 purchase-order DELETE guards the status in the DELETE', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    for (const [id, name] of [[COMPANY, 'R129 Company'], [OTHER_COMPANY, 'R129 Other']]) {
      await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,$2,true)`, [id, name]);
    }
    route = (await import('../../pages/api/accounting/purchase-orders/[id]')).default as unknown as Route;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    for (const c of [COMPANY, OTHER_COMPANY]) {
      await admin.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [c]);
      await admin.query('DELETE FROM purchase_orders WHERE company_id = $1', [c]);
      await admin.query('DELETE FROM suppliers WHERE company_id = $1', [c]);
      await admin.query('DELETE FROM companies WHERE id = $1', [c]);
    }
    await admin.end();
  });

  it('refuses to delete an order submitted between the status read and the DELETE', async () => {
    const po = await seedPo(COMPANY, 'draft');
    let submitted = 0;
    hooks.afterFirstStatusRead = async () => {
      submitted++;
      await admin.query(`UPDATE purchase_orders SET status = 'submitted' WHERE id = $1`, [po]);
    };
    try {
      const res = await del(po, COMPANY);
      expect(submitted).toBe(1); // the window was actually opened
      expect(await statusOf(po)).toBe('submitted');
      expect(await itemCount(po)).toBe(1);
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.body)).toContain('submitted');
    } finally {
      hooks.afterFirstStatusRead = null;
    }
  });

  it('still deletes a draft order, and its lines go with it', async () => {
    const po = await seedPo(COMPANY, 'draft');
    const res = await del(po, COMPANY);
    expect(res.statusCode).toBe(200);
    expect(await statusOf(po)).toBeNull();
    expect(await itemCount(po)).toBe(0);
  });

  it("answers 404 for another company's draft order and leaves it untouched", async () => {
    const po = await seedPo(OTHER_COMPANY, 'draft');
    const res = await del(po, COMPANY);
    expect(res.statusCode).toBe(404);
    expect(await statusOf(po)).toBe('draft');
    expect(await itemCount(po)).toBe(1);
  });
});
