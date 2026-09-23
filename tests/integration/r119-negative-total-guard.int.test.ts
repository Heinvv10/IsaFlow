/**
 * R-119 — a negative-total invoice is refused, at the database and at every
 * writer that could produce one.
 *
 * Nothing restricted the sign of `total_amount` on `customer_invoices` or
 * `supplier_invoices`, and four writers had no guard of their own. Such a
 * document is an ad-hoc credit note outside `credit_notes`: the ageing and
 * the subledger filter `balance > 0` and never show it, while its journal —
 * once posted — stands in the GL.
 *
 * Migration 692 is the backstop (a trigger, so pre-guard rows stay seedable
 * for the reports that must still handle them — see R-117); the writers
 * refuse first, with a message naming the remedy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { insertPreConstraintRow } from './helpers/preConstraintRow';
import { mintRecurringCustomerInvoice, mintRecurringSupplierInvoice } from '@/modules/accounting/services/core/recurringTransactionInvoices';
import { validatePipelineInput } from '@/modules/accounting/services/core/aiInvoicePipelineService';
import { importCustomerInvoices } from '@/modules/accounting/services/core/sageCustomerImportService';
import timeEntriesInvoice from '../../pages/api/accounting/time-entries-invoice';
import { SignJWT } from 'jose';
import { request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R119-${Date.now()}`;

let pool: Pool;
let customerId: string;

function run<T>(c: import('pg').PoolClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
}

async function drive<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  let committed = false;
  try {
    const out = await run(c, fn);
    await c.query('COMMIT');
    committed = true;
    return out;
  } finally {
    if (!committed) await c.query('ROLLBACK');
    c.release();
  }
}

/** Drive the time-entry route through withAuth, as the page does. */
async function callRoute(body: Record<string, unknown>) {
  const token = await new SignJWT({ sub: USER, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = body;
  req.query = {};
  req.url = '/api/accounting/time-entries-invoice';
  const out = response();
  await timeEntriesInvoice(req as never, out.res as never);
  return out.state;
}

const invoiceCount = async (): Promise<number> => Number(((await sql`
  SELECT count(*) AS n FROM customer_invoices WHERE company_id = ${COMPANY}::UUID
`) as { n: string }[])[0]!.n);

describeIfDb('R-119 a negative total is refused', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'R119 ' + TAG}, ${TAG}, NOW())`;
    await sql`
      INSERT INTO users (id, email, role, is_active)
      VALUES (${USER}, ${'r119-' + USER + '@isaflow.test'}, 'admin', true)`;
    await sql`
      INSERT INTO company_users (company_id, user_id, role)
      VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    customerId = ((await sql`
      INSERT INTO customers (name, company_id) VALUES ('R119 Customer', ${COMPANY}::UUID) RETURNING id
    `) as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM sage_customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM recurring_transaction_templates WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM time_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_migration_runs WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await pool.end();
  }, 60000);

  // ── The database, which is what closes the class ────────────────────────

  it.each(['customer_invoices', 'supplier_invoices'])('%s refuses a negative total outright', async (table) => {
    const entity = table === 'customer_invoices'
      ? sql`INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, invoice_date,
              subtotal, tax_amount, total_amount, status, created_by)
            VALUES (${COMPANY}::UUID, ${TAG + '-' + table}, ${customerId}::UUID, ${customerId}::UUID, CURRENT_DATE,
              -100, -15, -115, 'sent', ${USER})`
      : sql`INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date,
              subtotal, tax_amount, total_amount, status, created_by)
            VALUES (${COMPANY}::UUID, ${TAG + '-' + table}, ${randomUUID()}::UUID, CURRENT_DATE,
              -100, -15, -115, 'approved', ${USER})`;
    await expect(entity).rejects.toThrow(/negative total/i);
  });

  it('allows a legacy negative row to be corrected, but not re-set to another negative', async () => {
    // The shape production carries from before the guard.
    await insertPreConstraintRow(pool, `
      INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, invoice_date,
        subtotal, tax_amount, total_amount, status, created_by)
      VALUES ($1::UUID, $2, $3::UUID, $3::UUID, CURRENT_DATE, -100, -15, -115, 'sent', $4)`,
      [COMPANY, `${TAG}-legacy`, customerId, USER]);

    // Touching it without changing the total is allowed, so it can be cleaned up.
    await sql`
      UPDATE customer_invoices SET status = 'cancelled'
      WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${TAG + '-legacy'}`;
    // Correcting it to a non-negative total is allowed.
    await sql`
      UPDATE customer_invoices SET total_amount = 0
      WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${TAG + '-legacy'}`;
    // Moving it to a different negative is not.
    await expect(sql`
      UPDATE customer_invoices SET total_amount = -50
      WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${TAG + '-legacy'}`
    ).rejects.toThrow(/negative total/i);
  });

  it.each(['total_amount', 'subtotal', 'tax_amount'])('customer_invoices refuses NaN in %s', async (column) => {
    // NaN is worse than a negative: `NaN < 0` is FALSE so a sign test passes
    // it, `NaN > 0` is TRUE so it passes the `balance > 0` filter the ageing
    // uses, and SUM() over the column becomes NaN — one row destroys every
    // total for the company.
    const values: Record<string, string> = { total_amount: '115', subtotal: '100', tax_amount: '15' };
    values[column] = 'NaN';
    await expect(sql`
      INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, invoice_date,
        subtotal, tax_amount, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${`${TAG}-nan-${column}`}, ${customerId}::UUID, ${customerId}::UUID, CURRENT_DATE,
        ${values.subtotal}::numeric, ${values.tax_amount}::numeric, ${values.total_amount}::numeric, 'sent', ${USER})`
    ).rejects.toThrow(/NaN amount/i);
  });

  it('supplier_invoices refuses a legacy negative row being re-set to another negative', async () => {
    const supplierId = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R119 Supplier', ${COMPANY}::UUID) RETURNING id
    `) as { id: string }[])[0]!.id;
    await insertPreConstraintRow(pool, `
      INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date,
        subtotal, tax_amount, total_amount, status, created_by)
      VALUES ($1::UUID, $2, $3::UUID, CURRENT_DATE, -100, -15, -115, 'approved', $4)`,
      [COMPANY, `${TAG}-si-legacy`, supplierId, USER]);
    // The UPDATE arm of the supplier trigger, which the AR case alone left unproven.
    await expect(sql`
      UPDATE supplier_invoices SET total_amount = -50
      WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${TAG + '-si-legacy'}`
    ).rejects.toThrow(/negative total/i);
    await sql`
      UPDATE supplier_invoices SET total_amount = 0
      WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${TAG + '-si-legacy'}`;
  });

  // ── The writers, which refuse with the remedy named ─────────────────────

  it('the AI capture pipeline refuses a negative extracted total', () => {
    const base = { vendorName: 'R119 Vendor', date: '2026-06-30', referenceNumber: 'INV-1', lineItems: [{}] };
    const negative = validatePipelineInput({ ...base, totalAmount: -115 } as never);
    expect(negative.valid).toBe(false);
    expect(negative.errors.join(' ')).toMatch(/credit note/i);
    // The positive case is untouched.
    expect(validatePipelineInput({ ...base, totalAmount: 115 } as never).valid).toBe(true);
  });

  it('a recurring template refuses to execute into a negative invoice, and writes nothing', async () => {
    const before = await invoiceCount();
    const templateId = ((await sql`
      INSERT INTO recurring_transaction_templates
        (company_id, name, entity_type, template_data, frequency, next_run_date, created_by)
      VALUES (${COMPANY}::UUID, 'R119 negative template', 'customer_invoice',
        ${JSON.stringify({ clientId: customerId, subtotal: -100, vatAmount: -15, totalAmount: -115 })}::JSONB,
        'monthly', CURRENT_DATE, ${USER})
      RETURNING id`) as { id: string }[])[0]!.id;

    // The service takes a mapped RecurringTemplate, not the raw row.
    const template = {
      id: templateId, companyId: COMPANY, name: 'R119 negative template',
      entityType: 'customer_invoice' as const,
      templateData: { clientId: customerId, subtotal: -100, vatAmount: -15, totalAmount: -115 },
      frequency: 'monthly' as const, nextRunDate: null, lastRunDate: null,
      isActive: true, autoPost: false,
    };

    await expect(drive(() => mintRecurringCustomerInvoice(COMPANY, template as never, USER)))
      .rejects.toThrow(/credit note/i);
    expect(await invoiceCount()).toBe(before);
  });

  it('a recurring template whose stored total is not a number refuses before any write', async () => {
    // templateData is opaque JSON off the request body: `Number('abc')` is
    // NaN, which the database trigger also refuses — but this asserts the
    // WRITER's own guard, whose NaN branch a sign test would not cover.
    const before = await invoiceCount();
    const template = {
      id: randomUUID(), companyId: COMPANY, name: 'R119 NaN template',
      entityType: 'customer_invoice' as const,
      templateData: { clientId: customerId, totalAmount: 'abc' },
      frequency: 'monthly' as const, nextRunDate: null, lastRunDate: null,
      isActive: true, autoPost: false,
    };
    await expect(drive(() => mintRecurringCustomerInvoice(COMPANY, template as never, USER)))
      .rejects.toThrow(/not a number/i);
    expect(await invoiceCount()).toBe(before);
  });

  it('an AP recurring template refuses a negative total too', async () => {
    const supplierId = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R119 AP Supplier', ${COMPANY}::UUID) RETURNING id
    `) as { id: string }[])[0]!.id;
    const template = {
      id: randomUUID(), companyId: COMPANY, name: 'R119 negative bill template',
      entityType: 'supplier_invoice' as const,
      templateData: { supplierId, subtotal: -100, vatAmount: -15, totalAmount: -115 },
      frequency: 'monthly' as const, nextRunDate: null, lastRunDate: null,
      isActive: true, autoPost: false,
    };
    await expect(drive(() => mintRecurringSupplierInvoice(COMPANY, template as never, USER)))
      .rejects.toThrow(/credit note/i);
    const bills = (await sql`
      SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID AND supplier_id = ${supplierId}::UUID
    `) as { id: string }[];
    expect(bills).toHaveLength(0);
  });

  it('the time-entry route answers 400 with the remedy, not a 500, on a negative batch', async () => {
    // A negative rate on the entry, so the invoice total comes out negative.
    const entryId = ((await sql`
      INSERT INTO time_entries (company_id, user_id, customer_id, task_description, hours, rate, status, entry_date)
      VALUES (${COMPANY}::UUID, ${USER}, ${customerId}::UUID, 'R119 negative entry', 2, -100, 'submitted', CURRENT_DATE)
      RETURNING id`) as { id: string }[])[0]!.id;
    const before = await invoiceCount();

    const out = await callRoute({ timeEntryIds: [entryId], customerId });

    expect(out.statusCode).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/credit note/i);
    expect(await invoiceCount()).toBe(before);
  });

  it('the time-entry route refuses a tax rate outside 0..100', async () => {
    // A negative RATE keeps the total positive while the tax leg and the
    // output-VAT journal go negative — invisible to the total guard.
    const entryId = ((await sql`
      INSERT INTO time_entries (company_id, user_id, customer_id, task_description, hours, rate, status, entry_date)
      VALUES (${COMPANY}::UUID, ${USER}, ${customerId}::UUID, 'R119 rate entry', 2, 500, 'submitted', CURRENT_DATE)
      RETURNING id`) as { id: string }[])[0]!.id;
    const before = await invoiceCount();

    const out = await callRoute({ timeEntryIds: [entryId], customerId, taxRate: -99 });

    expect(out.statusCode).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/taxRate/);
    expect(await invoiceCount()).toBe(before);
  });

  it('the Sage AR import cannot yet reach its own guard — R-101 kills it first', async () => {
    // Honest about the state: sageCustomerImportService SELECTs columns
    // sage_customer_invoices does not have, so the run dies at 42703 before
    // any row is read (R-101, the twin of R-021 on the AR side). The sign
    // guard added there is therefore unreachable until R-101 lands; it is in
    // place so the importer cannot be revived without it, and the database
    // trigger covers the path meanwhile. This test pins WHY, so the next
    // session does not read the guard as proven.
    const before = await invoiceCount();
    await sql`
      INSERT INTO sage_customer_invoices
        (company_id, sage_id, invoice_number, customer_name, invoice_date, total_amount, migration_status)
      VALUES (${COMPANY}::UUID, ${TAG + '-SAGE'}, ${TAG + '-SINV'}, 'R119 Customer', '2026-06-30', -115, 'pending')`;

    await expect(drive(() => importCustomerInvoices(COMPANY, USER))).rejects.toThrow(/does not exist/);
    expect(await invoiceCount()).toBe(before);
  });
});
