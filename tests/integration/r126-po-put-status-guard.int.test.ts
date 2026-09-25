/**
 * R-126 — PUT /api/accounting/purchase-orders/[id] checked the status, then
 * UPDATEd with only id + company_id in the WHERE. This test opens that window
 * deterministically: the supplier check (which runs between the status read
 * and the UPDATE) approves the order through another connection, the way a
 * concurrent approval would. The edit must not land.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

const hooks = vi.hoisted(() => ({ betweenReadAndUpdate: null as null | (() => Promise<void>) }));

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    assertSupplierInCompany: async (...args: unknown[]) => {
      await (real.assertSupplierInCompany as (...a: unknown[]) => Promise<void>)(...args);
      if (hooks.betweenReadAndUpdate) await hooks.betweenReadAndUpdate();
    },
  };
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

async function put(id: string, companyId: string, body: Record<string, unknown>) {
  const res = mockRes();
  await route({ method: 'PUT', query: { id }, body, headers: {}, companyId, user: { id: USER } } as unknown as NextApiRequest, res);
  return res;
}

async function seedPo(companyId: string, status: string): Promise<string> {
  const supplier = (await admin.query(
    `INSERT INTO suppliers (company_id,name,is_active) VALUES ($1,'R126 Supplier',true) RETURNING id`, [companyId])).rows[0].id;
  return (await admin.query(
    `INSERT INTO purchase_orders (company_id,po_number,supplier_id,status,notes)
     VALUES ($1,$2,$3,$4,'original') RETURNING id`, [companyId, `R126-${randomUUID().slice(0, 8)}`, supplier, status])).rows[0].id;
}
const notesOf = async (id: string) =>
  (await admin.query('SELECT notes, status FROM purchase_orders WHERE id = $1', [id])).rows[0];

describeIfDb('R-126 purchase-order PUT guards the status in the UPDATE', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    for (const [id, name] of [[COMPANY, 'R126 Company'], [OTHER_COMPANY, 'R126 Other']]) {
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

  it('refuses an edit when the order is approved between the status read and the UPDATE', async () => {
    const po = await seedPo(COMPANY, 'submitted');
    let flipped = 0;
    hooks.betweenReadAndUpdate = async () => {
      flipped++;
      await admin.query(`UPDATE purchase_orders SET status = 'approved' WHERE id = $1`, [po]);
    };
    try {
      const res = await put(po, COMPANY, { notes: 'edited after approval' });
      expect(flipped).toBe(1); // the window was actually opened
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.body)).toContain('approved');
    } finally {
      hooks.betweenReadAndUpdate = null;
    }
    expect(await notesOf(po)).toEqual({ notes: 'original', status: 'approved' });
  });

  it('still saves an edit to a submitted order', async () => {
    const po = await seedPo(COMPANY, 'submitted');
    const res = await put(po, COMPANY, { notes: 'edited' });
    expect(res.statusCode).toBe(200);
    expect(await notesOf(po)).toEqual({ notes: 'edited', status: 'submitted' });
  });

  it("answers 404 for another company's order and leaves it untouched", async () => {
    const po = await seedPo(OTHER_COMPANY, 'draft');
    const res = await put(po, COMPANY, { notes: 'cross-tenant' });
    expect(res.statusCode).toBe(404);
    expect(await notesOf(po)).toEqual({ notes: 'original', status: 'draft' });
  });
});
