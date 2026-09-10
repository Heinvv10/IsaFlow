/**
 * Round-2 LOW-7 — the credit-note PDF builder poisoned the request transaction.
 *
 * `credit_note_items` does not exist in the schema, so
 * `SELECT * FROM credit_note_items` raised 42P01 on EVERY call and a bare
 * `catch {}` swallowed it. The route runs under `withAuth`, which holds one
 * transaction per request on an AsyncLocalStorage client, so from that point
 * the transaction was aborted: any query added to the route afterwards would
 * fail with 25P02 naming nothing useful, and the COMMIT would find a dead
 * transaction. There is no credit-note line table in this schema at all —
 * neither `credit_note_items` nor `credit_note_lines` — so the builder no longer
 * asks: the round-2 `to_regclass` probe was a round trip for a constant answer.
 *
 * Round-3 MEDIUM-3 is pinned here too: the customer, supplier and original
 * invoice joins carried no `company_id`, so a drifted `client_id` (the column has
 * no FK) printed another tenant's name, VAT number and billing address onto a
 * customer-facing PDF.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import { sql } from '../../src/lib/neon';
import { generateCreditNotePdf } from '../../src/modules/accounting/services/ar/creditNotePdfBuilder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const creditNote = crypto.randomUUID();
const driftedCreditNote = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const otherCustomer = crypto.randomUUID();
const otherInvoice = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name,is_active) VALUES($1,$2,true),($3,$4,true)',
    [company, 'K126c fixture', otherCompany, 'K126c other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name,vat_number,billing_address) VALUES($1,$2,$3,NULL,NULL),($4,$5,$6,$7,$8)',
    [customer, company, 'K126c customer',
     otherCustomer, otherCompany, 'K126C OTHER TENANT CUSTOMER', '4999999999', '9 Other Tenant Road']);
  await pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,
                              subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K126C-CN-1','customer',$3,'2026-01-01',100,15,15,115,'approved',$4)`,
    [creditNote, company, customer, user]);
  // The other tenant's invoice, and a credit note in OUR company whose client_id
  // and customer_invoice_id both point across the tenant boundary.
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K126C-OTHER-INV',$3,$3,'2026-01-01','2026-01-31',100,15,15,115,'approved',$4)`,
    [otherInvoice, otherCompany, otherCustomer, user]);
  await pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,customer_invoice_id,credit_date,
                              subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K126C-CN-2','customer',$3,$4,'2026-01-01',100,15,15,115,'approved',$5)`,
    [driftedCreditNote, company, otherCustomer, otherInvoice, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM credit_notes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [otherCompany]);
    await pool.query('DELETE FROM customers WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('leaves the request transaction usable, and commits', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const buf = await als.run(
      { client, userId: user, companyId: company, claims: {} },
      async () => {
        const pdf = await generateCreditNotePdf(company, creditNote);
        // The query a future edit to this route would add. Before the fix the
        // swallowed 42P01 had already aborted the transaction and this raised
        // 25P02 "current transaction is aborted".
        const rows = (await sql`SELECT 1 AS ok`) as Array<{ ok: number }>;
        expect(rows[0]!.ok).toBe(1);
        return pdf;
      },
    );

    expect(buf.length).toBeGreaterThan(0);
    // A poisoned transaction commits as ROLLBACK; this is the second half of
    // the same fact and the half a route silently depends on.
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

it('renders without a line-items table and still prints the totals block', async () => {
  const buf = await generateCreditNotePdf(company, creditNote);
  const text = [...buf.toString('latin1').matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
    .map((m) => m[1]!.replace(/\\([()\\])/g, '$1'));

  expect(text).toContain('Subtotal');
  expect(text).toContain('VAT (15%)');
});

it('will not print another tenant\'s customer or invoice on the PDF', async () => {
  const buf = await generateCreditNotePdf(company, driftedCreditNote);
  const text = [...buf.toString('latin1').matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
    .map((m) => m[1]!.replace(/\\([()\\])/g, '$1'));

  expect.soft(text).not.toContain('K126C OTHER TENANT CUSTOMER');
  expect.soft(text).not.toContain('4999999999');
  expect.soft(text).not.toContain('9 Other Tenant Road');
  expect(text).not.toContain('K126C-OTHER-INV');
});

it('will not render another tenant\'s credit note', async () => {
  await expect(generateCreditNotePdf(crypto.randomUUID(), creditNote))
    .rejects.toThrow(/Credit note not found/);
});
