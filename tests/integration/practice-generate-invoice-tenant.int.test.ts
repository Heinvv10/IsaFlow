/**
 * Generate Invoice form (audit 11 Nov 2026, item 12): the page posts to the
 * existing WIP invoice route and reads the existing WIP route, so these pin
 * what the form now relies on, driven through withAuth as the page drives it:
 *   - another company can neither invoice this company's client nor bill its
 *     time entries through a client of its own, and cannot read its WIP;
 *   - a chosen due date and a description are stored on the draft.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { ensureDocumentNumbers } from '@/modules/accounting/services/core/companySettingsService';
import wipInvoiceRoute from '../../pages/api/accounting/practice/wip/invoice';
import wipRoute from '../../pages/api/accounting/practice/wip';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const companyA = randomUUID();
const companyB = randomUUID();
const user = randomUUID();
const customerA = randomUUID();
const customerB = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();

type Out = { statusCode: number; body: { data?: unknown; error?: { message?: string } } };

async function call(route: typeof wipRoute, asCompany: string, method: 'GET' | 'POST', opts: { body?: unknown; query?: Record<string, string> }): Promise<Out> {
  const token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: asCompany }, method) as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = opts.body;
  req.query = opts.query ?? {};
  req.url = method === 'POST' ? '/api/accounting/practice/wip/invoice' : '/api/accounting/practice/wip';
  const out = response();
  await route(req as never, out.res as never);
  return out.state as Out;
}
const post = (asCompany: string, body: Record<string, unknown>) => call(wipInvoiceRoute, asCompany, 'POST', { body });
const message = (out: Out): string => String(out.body.error?.message ?? '');

async function seedEntry(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,
                              billable,invoiced,status,practice_client_id,applied_rate,line_total,origin)
     VALUES($1,$2,$3,'Generate Invoice fieldwork','2026-11-02',2,500,true,false,'approved',$4,500,1000,'manual')`,
    [id, companyA, user, clientA]);
  return id;
}
const entryState = async (id: string) => (await pool.query(
  'SELECT status, invoice_id, billed_at FROM time_entries WHERE id=$1', [id])).rows[0];
const invoiceCount = async (company: string): Promise<number> => (await pool.query(
  'SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [company])).rows[0]!.n;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [companyA, 'GI company A', companyB, 'GI company B']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  // One user in both companies: only the active company decides what is reachable.
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$3,'admin'),($2,$3,'admin')", [companyA, companyB, user]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [customerA, companyA, 'GI customer A', customerB, companyB, 'GI customer B']);
  await pool.query(
    `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
     VALUES($1,$2,'GI client A','hourly','active',$3), ($4,$5,'GI client B','hourly','active',$6)`,
    [clientA, companyA, customerA, clientB, companyB, customerB]);
  await ensureDocumentNumbers(companyA);
  await ensureDocumentNumbers(companyB);
});

afterAll(async () => {
  try {
    const both = [companyA, companyB];
    await pool.query('UPDATE time_entries SET invoice_id=NULL WHERE company_id = ANY($1)', [both]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))', [both]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [both]);
    await pool.query('DELETE FROM time_entries WHERE company_id = ANY($1)', [both]);
    await pool.query('DELETE FROM practice_clients WHERE company_id = ANY($1)', [both]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [both]);
    await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [both]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [both]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [both]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('Generate Invoice: tenant isolation of the WIP routes', () => {
  it('refuses company B invoicing company A\'s client', async () => {
    const entry = await seedEntry();
    const out = await post(companyB, { practiceClientId: clientA, timeEntryIds: [entry] });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toMatch(/practice client not found/);
    expect(await invoiceCount(companyB)).toBe(0);
    expect(await entryState(entry)).toMatchObject({ status: 'approved', invoice_id: null, billed_at: null });
  });

  it('refuses company B billing company A\'s entries through its own client, and leaves them unbilled', async () => {
    const entry = await seedEntry();
    const out = await post(companyB, { practiceClientId: clientB, timeEntryIds: [entry] });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toMatch(/no eligible approved time entries/);
    expect(await invoiceCount(companyB)).toBe(0);
    expect(await entryState(entry)).toMatchObject({ status: 'approved', invoice_id: null, billed_at: null });
  });

  it('shows company B none of company A\'s WIP, even by A\'s client id', async () => {
    await seedEntry();
    const asB = await call(wipRoute, companyB, 'GET', { query: { practiceClientId: clientA } });
    expect(asB.statusCode).toBe(200);
    expect(asB.body.data).toEqual([]);
    const asA = await call(wipRoute, companyA, 'GET', { query: { practiceClientId: clientA } });
    expect((asA.body.data as unknown[]).length).toBe(1);
  });

  it('answers a malformed practiceClientId 400, not a database error', async () => {
    const out = await call(wipRoute, companyA, 'GET', { query: { practiceClientId: 'nope' } });
    expect(out.statusCode).toBe(400);
  });
});

describe('Generate Invoice: due date and description', () => {
  it('stores a chosen due date as manual and the description as notes on the draft', async () => {
    const entry = await seedEntry();
    const out = await post(companyA, {
      practiceClientId: clientA, timeEntryIds: [entry], invoiceDate: '2026-11-05',
      dueDate: '2027-01-31', notes: 'November advisory', taxRate: 15,
    });
    expect(out.statusCode).toBe(201);
    const { invoiceId } = out.body.data as { invoiceId: string };
    const row = (await pool.query(
      `SELECT status, due_date::TEXT AS due_date, due_date_source, notes, subtotal::TEXT, tax_amount::TEXT
         FROM customer_invoices WHERE id=$1 AND company_id=$2`, [invoiceId, companyA])).rows[0];
    expect(row).toEqual({
      status: 'draft', due_date: '2027-01-31', due_date_source: 'manual', notes: 'November advisory',
      subtotal: '1000.00', tax_amount: '150.00',
    });
    expect(await entryState(entry)).toMatchObject({ invoice_id: invoiceId });
  });

  it('refuses a due date before the invoice date and writes nothing', async () => {
    const entry = await seedEntry();
    const before = await invoiceCount(companyA);
    const out = await post(companyA, { practiceClientId: clientA, timeEntryIds: [entry], invoiceDate: '2026-11-05', dueDate: '2026-11-04' });
    expect(out.statusCode).toBe(400);
    expect(message(out)).toBe('Due date cannot be before the invoice date');
    expect(await invoiceCount(companyA)).toBe(before);
  });
});
