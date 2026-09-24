/**
 * K-137 — RED. The PUT arm of pages/api/accounting/supplier-invoices-detail.ts
 * (lines 32-53 on origin/master) guards its UPDATE with
 * `AND status IN ('draft','pending_approval')`, never looks at the row count,
 * and then re-fetches and returns 200.
 *
 * CORRECTED MECHANISM. The audit said the re-fetch throws and the route answers
 * 400 after committing. It does not throw: `getSupplierInvoiceById` returns the
 * row (or null) rather than raising. The real behaviour is worse and quieter —
 * an edit to an APPROVED or PAID bill is answered 200 with the unchanged
 * invoice, so the screen shows the save succeeded and the new invoice number,
 * date or payment terms are silently discarded.
 *
 * The same absence of a row-count check makes a PUT for another company's
 * invoice id answer 200 with a null body instead of 404.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let draftInvoice = '';
let approvedInvoice = '';
let foreignInvoice = '';
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

async function put(body: unknown) {
  const res = mockRes();
  await route({ method: 'PUT', body, query: {}, headers: {}, companyId: COMPANY, user: { id: USER } } as unknown as NextApiRequest, res);
  return res;
}

async function mkInvoice(company: string, supplier: string, number: string, status: string) {
  const r = await admin.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, subtotal, total_amount,
        amount_paid, status, created_by)
     VALUES ($1,$2,$3,'2026-03-01',1000,1000,0,$4,$5) RETURNING id`,
    [company, supplier, number, status, USER]);
  return r.rows[0].id as string;
}

describeIfDb('K-137 a PUT that changes nothing must not answer 200', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'K137 Company',true),($2,'K137 Other',true)`,
      [COMPANY, OTHER_COMPANY]);
    const s1 = await admin.query(`INSERT INTO suppliers (company_id,name) VALUES ($1,'K137 Supplier') RETURNING id`, [COMPANY]);
    const s2 = await admin.query(`INSERT INTO suppliers (company_id,name) VALUES ($1,'K137 Foreign') RETURNING id`, [OTHER_COMPANY]);
    draftInvoice = await mkInvoice(COMPANY, s1.rows[0].id, 'K137-DRAFT', 'draft');
    approvedInvoice = await mkInvoice(COMPANY, s1.rows[0].id, 'K137-APPROVED', 'approved');
    foreignInvoice = await mkInvoice(OTHER_COMPANY, s2.rows[0].id, 'K137-FOREIGN', 'draft');
    route = (await import('../../pages/api/accounting/supplier-invoices-detail')).default as unknown as Route;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    const both = [[COMPANY, OTHER_COMPANY]];
    await admin.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', both);
    await admin.query('DELETE FROM suppliers WHERE company_id = ANY($1)', both);
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', both);
    await admin.end();
  });

  it('still edits a draft invoice (control)', async () => {
    const res = await put({ id: draftInvoice, notes: 'K137 edited' });
    expect(res.statusCode).toBe(200);
    const row = await admin.query('SELECT notes FROM supplier_invoices WHERE id = $1', [draftInvoice]);
    expect(row.rows[0].notes).toBe('K137 edited');
  });

  it('refuses an edit to an approved invoice instead of reporting success', async () => {
    const res = await put({ id: approvedInvoice, invoiceNumber: 'K137-REWRITTEN' });
    const row = await admin.query('SELECT invoice_number FROM supplier_invoices WHERE id = $1', [approvedInvoice]);
    expect(row.rows[0].invoice_number).toBe('K137-APPROVED');   // nothing changed …
    expect(res.statusCode).toBeGreaterThanOrEqual(400);          // … and the caller was told so
  });

  it('answers 404 for an invoice belonging to another company', async () => {
    const res = await put({ id: foreignInvoice, notes: 'K137 cross-tenant' });
    expect(res.statusCode).toBe(404);
  });
});
