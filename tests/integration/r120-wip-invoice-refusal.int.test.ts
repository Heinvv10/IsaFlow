/**
 * R-120 — the practice WIP invoice route told the operator nothing.
 *
 * `pages/api/accounting/practice/wip/invoice.ts` answered every error with
 * `badRequestFromError(..., 'WIP invoice failed')`, which drops the message
 * outside development. A refusal the operator can act on — no linked AR
 * customer, nothing eligible, a tax rate out of range, a time entry that makes
 * a negative line — reached the page as "WIP invoice failed". And a tax rate
 * the route never validated reached migration 692's trigger as a raw error.
 *
 * Driven through withAuth, as the WIP page drives it; NODE_ENV is 'test', so
 * the production masking applies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { ensureDocumentNumbers } from '@/modules/accounting/services/core/companySettingsService';
import wipInvoiceRoute from '../../pages/api/accounting/practice/wip/invoice';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = randomUUID();
const user = randomUUID();
const customer = randomUUID();
const client = randomUUID();
const unlinkedClient = randomUUID();

async function callRoute(body: Record<string, unknown>) {
  const token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = body;
  req.query = {};
  req.url = '/api/accounting/practice/wip/invoice';
  const out = response();
  await wipInvoiceRoute(req as never, out.res as never);
  return out.state as { statusCode: number; body: { error?: { message?: string } } };
}

async function seedEntry(opts: { hours?: number; rate?: number; lineTotal?: number } = {}): Promise<string> {
  const id = randomUUID();
  const hours = opts.hours ?? 4;
  const rate = opts.rate ?? 250;
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,
                              billable,invoiced,status,practice_client_id,applied_rate,line_total,origin)
     VALUES($1,$2,$3,'R120 fieldwork','2026-01-05',$4,$5,true,false,'approved',$6,$5,$7,'manual')`,
    [id, company, user, hours, rate, client, opts.lineTotal ?? hours * rate]);
  return id;
}

const invoiceCount = async (): Promise<number> => (await pool.query(
  'SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [company])).rows[0]!.n;
const message = (out: { body: { error?: { message?: string } } }): string => String(out.body.error?.message ?? '');

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'R120 WIP company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'R120 customer']);
  await pool.query(
    `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
     VALUES($1,$2,'R120 client','hourly','active',$3), ($4,$2,'R120 unlinked','hourly','active',NULL)`,
    [client, company, customer, unlinkedClient]);
  await ensureDocumentNumbers(company);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE time_entries SET invoice_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM time_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM practice_clients WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('R-120: a refused WIP invoice tells the operator why', () => {
  it('names the missing AR customer link', async () => {
    const out = await callRoute({ practiceClientId: unlinkedClient, timeEntryIds: [randomUUID()] });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toMatch(/no linked AR customer/);
  });

  it('says when nothing in the selection is billable', async () => {
    const out = await callRoute({ practiceClientId: client, timeEntryIds: [randomUUID()] });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toMatch(/no eligible approved time entries/);
  });

  it.each([-99, 101, 'abc'])('refuses taxRate %s before anything is written, naming the field', async (taxRate) => {
    const entry = await seedEntry();
    const before = await invoiceCount();
    const out = await callRoute({ practiceClientId: client, timeEntryIds: [entry], taxRate });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toMatch(/taxRate/);
    expect(await invoiceCount()).toBe(before);
  });

  it('accepts a seeded, non-RFC-version id (Zod 4 .uuid() would refuse it)', async () => {
    const out = await callRoute({ practiceClientId: client, timeEntryIds: ['00000000-0000-0000-0000-00000000000a'] });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toMatch(/no eligible approved time entries/);
  });

  it('refuses a malformed selection by field, not with a database error', async () => {
    const out = await callRoute({ practiceClientId: client, timeEntryIds: ['not-a-uuid'] });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toMatch(/timeEntryIds/);
  });

  it('refuses an entry whose line is negative, and leaves it unbilled', async () => {
    const good = await seedEntry();
    // time_entries CHECKs hours > 0 but nothing constrains rate or line_total.
    // Small enough that the invoice total stays positive: a sum check alone passes it.
    const bad = await seedEntry({ rate: -50 });
    const before = await invoiceCount();
    const out = await callRoute({ practiceClientId: client, timeEntryIds: [good, bad] });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toMatch(/negative/i);
    expect(await invoiceCount()).toBe(before);
    const rows = (await pool.query('SELECT status FROM time_entries WHERE id = ANY($1)', [[good, bad]])).rows;
    expect(rows.map(r => r.status)).toEqual(['approved', 'approved']);
  });

  it('answers lock contention 503 with the retry message, not a masked 400', async () => {
    const entry = await seedEntry();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM time_entries WHERE id=$1 FOR UPDATE', [entry]);
      const out = await callRoute({ practiceClientId: client, timeEntryIds: [entry] });
      expect(out.statusCode).toBe(503);
      expect(message(out)).toMatch(/retry/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 20_000);

  it('still bills a valid selection (201)', async () => {
    const entry = await seedEntry();
    const out = await callRoute({ practiceClientId: client, timeEntryIds: [entry], taxRate: 15 });
    expect(out.statusCode).toBe(201);
  });
});
