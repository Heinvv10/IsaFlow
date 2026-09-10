/**
 * K-107 round 5, HIGH-2 (second copy) — `pages/api/accounting/time-entries-invoice.ts`.
 *
 * The route carried a near-identical copy of the WIP defect: it read the
 * eligible entries (`invoiced = false AND billable = true`), minted a full
 * customer invoice with lines, then marked the entries invoiced with an UPDATE
 * that matched on id + company only and whose row count was discarded. Two
 * concurrent POSTs over the same ids both billed the customer.
 *
 * The auth/CSRF wrappers are mocked away so the handler itself can be driven
 * against the real fixture database inside a real transaction — everything
 * below the wrapper, including the SQL, is the shipped code.
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

const { default: handler } = await import('../../pages/api/accounting/time-entries-invoice');
const { ensureDocumentNumbers } = await import('../../src/modules/accounting/services/core/companySettingsService');

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const customer = crypto.randomUUID();

/** How long the winner holds its transaction open while the loser is parked. */
const HOLD_MS = 300;

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

const post = (ids: string[]) => ({
  method: 'POST',
  user: { id: user },
  companyId: company,
  body: { timeEntryIds: ids, customerId: customer },
} as unknown as NextApiRequest);

async function call(ids: string[], client: PoolClient): Promise<Res> {
  const res = makeRes();
  await als.run(ctxFor(client), () => handler(post(ids), res));
  return res;
}

async function seedEntry(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,
                              billable,invoiced,status,customer_id,origin)
     VALUES($1,$2,$3,'Advisory','2026-02-10',3,400,true,false,'approved',$4,'manual')`,
    [id, company, user, customer]);
  return id;
}

async function invoiceCount(): Promise<number> {
  const r = await pool.query('SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [company]);
  return Number(r.rows[0].n);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R5 TE route fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K107 TE customer']);
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE time_entries SET invoice_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM time_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('mints ONE invoice when two POSTs bill the same entries simultaneously', async () => {
  const entry = await seedEntry();
  const before = await invoiceCount();
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    const first = await call([entry], a);
    expect.soft(first.statusCode).toBe(201);

    let settled = false;
    const attempt = call([entry], b);
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    // A holds the entry row: B is parked on the lock. Without it B would
    // already have inserted a second invoice.
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const second = await attempt;
    await b.query('ROLLBACK');
    // Nothing eligible left — a pre-write refusal, so a 4xx here commits nothing.
    expect.soft(second.statusCode).toBe(400);
  } finally { a.release(); b.release(); }

  expect.soft(await invoiceCount()).toBe(before + 1);
  const marked = await pool.query(
    "SELECT count(*)::int AS n FROM time_entries WHERE id=$1 AND invoiced = true AND status='invoiced'", [entry]);
  expect(Number(marked.rows[0].n)).toBe(1);
});

it('bills once and foots on the legitimate path, from the company sequence', async () => {
  const one = await seedEntry(), two = await seedEntry();
  const client = await pool.connect();
  let body: { data?: { invoiceId: string; invoiceNumber: string; subtotal: number; taxAmount: number; totalAmount: number } };
  try {
    await client.query('BEGIN');
    const res = await call([one, two], client);
    expect.soft(res.statusCode).toBe(201);
    body = res.body as typeof body;
    await client.query('COMMIT');
  } finally { client.release(); }

  const payload = body!.data!;
  expect.soft(payload.subtotal).toBeCloseTo(2400, 2);
  expect.soft(payload.totalAmount).toBeCloseTo(payload.subtotal + payload.taxAmount, 2);
  // The number came from the company sequence, not the old INV-nnnnn generator.
  expect.soft(payload.invoiceNumber).not.toMatch(/^INV-\d+$/);

  const lines = await pool.query(
    'SELECT amount FROM customer_invoice_items WHERE invoice_id=$1', [payload.invoiceId]);
  const sum = lines.rows.reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);
  const header = await pool.query(
    'SELECT subtotal, tax_amount, total_amount FROM customer_invoices WHERE id=$1', [payload.invoiceId]);
  expect.soft(sum).toBeCloseTo(Number(header.rows[0].subtotal), 2);
  expect(Number(header.rows[0].total_amount))
    .toBeCloseTo(Number(header.rows[0].subtotal) + Number(header.rows[0].tax_amount), 2);
});

it('refuses a re-POST of already-invoiced entries without minting', async () => {
  const entry = await seedEntry();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await call([entry], client);
    await client.query('COMMIT');
  } finally { client.release(); }

  const before = await invoiceCount();
  const retry = await pool.connect();
  try {
    await retry.query('BEGIN');
    const res = await call([entry], retry);
    expect.soft(res.statusCode).toBe(400);
    await retry.query('ROLLBACK');
  } finally { retry.release(); }
  expect(await invoiceCount()).toBe(before);
});

it('will not bill another tenant\'s entries through this route', async () => {
  const otherCompany = crypto.randomUUID();
  const theirs = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K107 R5 TE other']);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [crypto.randomUUID(), otherCompany, 'other']);
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,
                              billable,invoiced,status,origin)
     VALUES($1,$2,$3,'Theirs','2026-02-10',3,400,true,false,'approved','manual')`,
    [theirs, otherCompany, user]);

  const mine = await seedEntry();
  const before = await invoiceCount();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await call([mine, theirs], client);
    expect.soft(res.statusCode).toBe(201);
    expect.soft((res.body as { data: { lineCount: number } }).data.lineCount).toBe(1);
    await client.query('COMMIT');
  } finally { client.release(); }

  expect.soft(await invoiceCount()).toBe(before + 1);
  const untouched = await pool.query('SELECT invoiced, invoice_id FROM time_entries WHERE id=$1', [theirs]);
  expect.soft(untouched.rows[0].invoiced).toBe(false);
  expect.soft(untouched.rows[0].invoice_id).toBeNull();

  await pool.query('DELETE FROM time_entries WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM customers WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
});

it('refuses an entry the practice WIP path has already billed', async () => {
  // The two billing subsystems on this table use DIFFERENT columns: the WIP
  // path marks status='billed' + billed_at and leaves `invoiced` false, while
  // this route read only `invoiced = false`. Every entry already invoiced
  // through the practice screen was therefore still offered here, and billed to
  // the client a second time — serially, with no concurrency involved.
  const entry = await seedEntry();
  await pool.query(
    "UPDATE time_entries SET status='billed', billed_at=NOW() WHERE id=$1", [entry]);

  const before = await invoiceCount();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await call([entry], client);
    expect.soft(res.statusCode).toBe(400);
    await client.query('ROLLBACK');
  } finally { client.release(); }

  expect.soft(await invoiceCount()).toBe(before);
  const still = await pool.query('SELECT invoiced, invoice_id FROM time_entries WHERE id=$1', [entry]);
  expect.soft(still.rows[0].invoiced).toBe(false);
  expect(still.rows[0].invoice_id).toBeNull();
});
