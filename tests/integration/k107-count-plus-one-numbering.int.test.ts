/**
 * K-107 round 5, MEDIUM-2 and LOW-4 — the COUNT(*)+1 numbering family.
 *
 * Five write paths built a document number from `COUNT(*) + 1` over the rows
 * that already exist. Count is not max: delete ONE row and every later create
 * re-issues a number that is already taken. Where a unique index exists that is
 * a permanent 23505 — creation for that company is wedged until someone
 * renumbers by hand — and where none exists it is a silent duplicate on a
 * document that carries money.
 *
 * | path | index | old result after one deletion |
 * |---|---|---|
 * | pages/api/accounting/purchase-orders | UNIQUE(company_id, po_number) | wedged |
 * | pages/api/accounting/projects | UNIQUE(company_id, project_number) | wedged |
 * | pages/api/accounting/assets | UNIQUE(company_id, asset_number) | wedged |
 * | pages/api/accounting/supplier-returns | none | silent duplicate |
 *
 * Purchase orders and supplier returns now reserve from the company sequence;
 * the rest use MAX of the numbers already minted under their prefix, which is
 * the smallest change that removes the wedge where there is no sequence type to
 * reserve from. The auth/CSRF wrappers are mocked so the shipped handlers run
 * against the real fixture database.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

const { default: poHandler } = await import('../../pages/api/accounting/purchase-orders');
const { default: projectHandler } = await import('../../pages/api/accounting/projects');
const { default: returnHandler } = await import('../../pages/api/accounting/supplier-returns');
const { ensureDocumentNumbers } = await import('../../src/modules/accounting/services/core/companySettingsService');

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const supplier = crypto.randomUUID();
const customer = crypto.randomUUID();

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

type Res = NextApiResponse & { statusCode: number; body?: unknown };
function makeRes(): Res {
  const res = { statusCode: 200 } as unknown as Res;
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = vi.fn((b: unknown) => { res.body = b; return res; }) as never;
  res.setHeader = vi.fn(() => res) as never;
  return res;
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

/** Run a handler in its own committed transaction, exactly as withAuth does. */
async function post(handler: Handler, body: unknown): Promise<Res> {
  const res = makeRes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run(ctxFor(client), () => handler({
      method: 'POST', user: { id: user }, companyId: company, body, query: {},
    } as unknown as NextApiRequest, res));
    await client.query(res.statusCode >= 500 ? 'ROLLBACK' : 'COMMIT');
  } finally { client.release(); }
  return res;
}

const PO_BODY = {
  supplierId: supplier,
  items: [{ description: 'Cable', quantity: 10, unitPrice: 50, taxRate: 15 }],
};

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R5 numbering fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'K107 supplier']);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K107 numbering customer']);
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM purchase_orders WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM projects WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM items WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('keeps creating purchase orders after one is deleted', async () => {
  const first = await post(poHandler, PO_BODY);
  expect.soft(first.statusCode).toBe(201);
  const second = await post(poHandler, PO_BODY);
  expect.soft(second.statusCode).toBe(201);

  // Delete one. Under COUNT(*)+1 every later create now asks for a number that
  // already exists and 23505s, permanently.
  const firstId = (first.body as { data: { id: string } }).data.id;
  await pool.query('DELETE FROM po_items WHERE purchase_order_id=$1', [firstId]);
  await pool.query('DELETE FROM purchase_orders WHERE id=$1', [firstId]);

  const third = await post(poHandler, PO_BODY);
  expect.soft(third.statusCode).toBe(201);
  const fourth = await post(poHandler, PO_BODY);
  expect.soft(fourth.statusCode).toBe(201);

  const all = await pool.query('SELECT po_number FROM purchase_orders WHERE company_id=$1', [company]);
  const numbers = all.rows.map((r: { po_number: string }) => String(r.po_number));
  expect(new Set(numbers).size).toBe(numbers.length);
});

it('mints two DISTINCT PO numbers for two concurrent creates', async () => {
  const [a, b] = await Promise.all([post(poHandler, PO_BODY), post(poHandler, PO_BODY)]);
  expect.soft(a.statusCode).toBe(201);
  expect.soft(b.statusCode).toBe(201);
  const numberOf = (r: Res) => String((r.body as { data: { po_number: string } }).data.po_number);
  expect(numberOf(a)).not.toBe(numberOf(b));
});

it('keeps creating projects after one is deleted', async () => {
  const first = await post(projectHandler, { name: 'Alpha', clientId: customer });
  expect.soft(first.statusCode).toBe(201);
  await post(projectHandler, { name: 'Beta', clientId: customer });
  await pool.query('DELETE FROM projects WHERE id=$1', [(first.body as { data: { id: string } }).data.id]);

  const third = await post(projectHandler, { name: 'Gamma', clientId: customer });
  expect.soft(third.statusCode).toBe(201);
  const all = await pool.query('SELECT project_number FROM projects WHERE company_id=$1', [company]);
  const numbers = all.rows.map((r: { project_number: string }) => String(r.project_number));
  expect(new Set(numbers).size).toBe(numbers.length);
});

it('numbers supplier returns from the company sequence, with no repeat after a deletion', async () => {
  const first = await post(returnHandler, { supplierId: supplier, amount: 100, reason: 'damaged' });
  expect.soft(first.statusCode).toBe(200);
  const second = await post(returnHandler, { supplierId: supplier, amount: 200, reason: 'wrong item' });
  expect.soft(second.statusCode).toBe(200);
  const numberOf = (r: Res) => String((r.body as { data: { return: { credit_note_number: string } } }).data.return.credit_note_number);
  expect.soft(numberOf(first)).not.toBe(numberOf(second));
  // From the sequence, not DR-nnnn.
  expect.soft(numberOf(first)).not.toMatch(/^DR-\d+$/);

  await pool.query('DELETE FROM credit_notes WHERE credit_note_number=$1 AND company_id=$2', [numberOf(first), company]);
  const third = await post(returnHandler, { supplierId: supplier, amount: 300, reason: 'short delivered' });
  expect.soft(numberOf(third)).not.toBe(numberOf(second));
  expect(numberOf(third)).not.toBe(numberOf(first));
});

it('scopes every one of these numbers to the company', async () => {
  // Each numbering read above filters on company_id; a second tenant creating
  // documents must not move this company's next number.
  const otherCompany = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K107 R5 numbering other']);
  await pool.query(
    `INSERT INTO projects(id,company_id,project_number,name,created_by)
     VALUES($1,$2,'PROJ-9999','Theirs',$3)`, [crypto.randomUUID(), otherCompany, user]);

  const mine = await post(projectHandler, { name: 'Delta', clientId: customer });
  expect.soft(mine.statusCode).toBe(201);
  expect.soft(String((mine.body as { data: { project_number: string } }).data.project_number)).not.toContain('9999');

  await pool.query('DELETE FROM projects WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
});

it('gives every auto-coded item its own code, and keeps going after one is deleted', async () => {
  const { createItem } = await import('../../src/modules/accounting/services/items/itemService');
  const client = await pool.connect();
  const codes: string[] = [];
  try {
    await client.query('BEGIN');
    await als.run(ctxFor(client), async () => {
      for (let i = 0; i < 2; i++) {
        const row = await createItem(company, { description: `Item ${i}` } as never);
        codes.push(String((row as { code: unknown }).code));
      }
    });
    await client.query('COMMIT');
  } finally { client.release(); }
  expect.soft(codes[0]).not.toBe(codes[1]);

  await pool.query('DELETE FROM items WHERE company_id=$1 AND code=$2', [company, codes[0]]);
  const after = await pool.connect();
  try {
    await after.query('BEGIN');
    const row = await als.run(ctxFor(after), () => createItem(company, { description: 'Item 2' } as never));
    await after.query('COMMIT');
    expect(String((row as { code: unknown }).code)).not.toBe(codes[1]);
  } finally { after.release(); }
});
