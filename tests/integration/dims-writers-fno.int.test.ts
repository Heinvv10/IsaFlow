/**
 * Every writer of customer_invoice_items stores the customer's FNO on each line
 * (#663 review, MEDIUM 3): posting no longer applies it (dimensionStoredPosting),
 * so a writer that left it off would make a customer with an FNO un-postable,
 * and one applied at post time escaped the approval digest. Create, quote,
 * sales-order, time-entry and WIP billing, both recurring runners and the Sage
 * import each store it; the ones that post at once post it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import customerQuotes from '../../pages/api/accounting/customer-quotes';
import customerQuotesAction from '../../pages/api/accounting/customer-quotes-action';
import timeEntriesInvoice from '../../pages/api/accounting/time-entries-invoice';
import { convertSalesOrderToInvoice } from '../../src/modules/accounting/services/ar/salesOrderWorkflowService';
import { generateWipInvoice } from '../../src/modules/accounting/services/practice/practiceWipService';
import { createDraftCustomerInvoice } from '../../src/modules/accounting/services/ar/customerInvoiceCreateService';
import { generateInvoiceFromRecurring } from '../../src/modules/accounting/services/ar/recurringInvoiceRun';
import { mintRecurringCustomerInvoice } from '../../src/modules/accounting/services/core/recurringTransactionInvoices';
import { commitARInvoice } from '../../src/modules/admin/services/sageMigrationCommitService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr4, invoiceCompany } from './r035-pr4.helpers';
import { cleanupDims, plantDims } from './dims-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id = ANY($1)', [companies]);
  await cleanupDims(pool, companies);
  await cleanupPr4(pool, companies, [user]);
});

/** A company whose customer has FNO `fno`. */
async function fixture(): Promise<{ c: string; customer: string; fno: string; name: string }> {
  const c = await invoiceCompany(pool, [[user, 'owner']], companies);
  const { fno1: fno } = await plantDims(pool, c);
  const customer = crypto.randomUUID();
  const name = `FNO customer ${customer.slice(0, 6)}`;
  await pool.query('INSERT INTO customers(id,company_id,name,default_cc1_id) VALUES($1,$2,$3,$4)', [customer, c, name, fno]);
  return { c, customer, fno, name };
}

async function inRequest<T>(c: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: user, companyId: c, claims: { sub: user } } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Every line's cc1, and every revenue line's cc1 if the invoice posted. */
async function fnosOf(invoiceId: string) {
  const lines = (await pool.query('SELECT cc1_id FROM customer_invoice_items WHERE invoice_id = $1', [invoiceId])).rows;
  const posted = (await pool.query(
    `SELECT jl.cc1_id FROM customer_invoices ci
     JOIN gl_journal_lines jl ON jl.journal_entry_id = ci.gl_journal_entry_id
     JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.account_subtype = 'default_revenue'
     WHERE ci.id = $1`, [invoiceId])).rows;
  return { lines: lines.map((r) => r.cc1_id as string | null), posted: posted.map((r) => r.cc1_id as string | null) };
}

const post = (c: string, handler: never, body: unknown, url: string) => callRoute(handler, tokens[user]!, c, 'POST', body, url);

describe('the customer FNO is stored by', () => {
  it('create, with no dimension named', async () => {
    const f = await fixture();
    const { id } = await createDraftCustomerInvoice(f.c, user, { clientId: f.customer, items: [{ description: 'A', unitPrice: 10 }] });
    expect((await fnosOf(id)).lines).toEqual([f.fno]);
  });

  it('quote conversion', async () => {
    const f = await fixture();
    const quote = dataOf<{ id: string }>(await post(f.c, customerQuotes as never, {
      clientId: f.customer, quoteDate: '2026-09-01', lines: [{ description: 'Build', quantity: 1, unitPrice: 100, taxRate: 15 }],
    }, '/api/accounting/customer-quotes'));
    await post(f.c, customerQuotesAction as never, { id: quote.id, action: 'accept' }, '/api/accounting/customer-quotes-action');
    const converted = await post(f.c, customerQuotesAction as never, { id: quote.id, action: 'convert' }, '/api/accounting/customer-quotes-action');
    expect(converted.state.statusCode, JSON.stringify(converted.state.body)).toBe(200);
    expect((await fnosOf(dataOf<{ invoiceId: string }>(converted).invoiceId)).lines).toEqual([f.fno]);
  });

  it('sales-order conversion', async () => {
    const f = await fixture();
    const order = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,$2,$3,$4,DATE '2026-09-01',1000,150,1150,'confirmed',$5)`, [order, f.c, `SO-${order.slice(0, 6)}`, f.customer, user]);
    await pool.query(
      `INSERT INTO customer_sales_order_items(sales_order_id,description,quantity,unit_price,tax_rate,line_total)
       VALUES($1,'Goods',1,1000,15,1000)`, [order]);
    const { invoiceId } = await inRequest(f.c, () => convertSalesOrderToInvoice(f.c, order, user));
    expect((await fnosOf(invoiceId)).lines).toEqual([f.fno]);
  });

  const timeEntry = async (c: string, practiceClientId: string | null = null) => {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,billable,invoiced,status,
         practice_client_id,applied_rate,line_total,origin)
       VALUES($1,$2,$3,'Fieldwork',DATE '2026-09-01',4,250,true,false,$4,$5,250,1000,'manual')`,
      [id, c, user, practiceClientId ? 'approved' : 'draft', practiceClientId]);
    return id;
  };

  it('time-entry billing', async () => {
    const f = await fixture();
    const res = await post(f.c, timeEntriesInvoice as never, { timeEntryIds: [await timeEntry(f.c)], customerId: f.customer },
      '/api/accounting/time-entries-invoice');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    expect((await fnosOf(dataOf<{ invoiceId: string }>(res).invoiceId)).lines).toEqual([f.fno]);
  });

  it.each(['detailed', 'by_category'] as const)('WIP billing, %s', async (groupBy) => {
    const f = await fixture();
    const practiceClientId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
       VALUES($1,$2,'Dims practice client','hourly','active',$3)`, [practiceClientId, f.c, f.customer]);
    const ids = [await timeEntry(f.c, practiceClientId)];
    const out = await inRequest(f.c, () => generateWipInvoice(f.c, user, { practiceClientId, timeEntryIds: ids, groupBy }));
    expect((await fnosOf(out.invoiceId)).lines).toEqual([f.fno]);
  });

  it('the recurring-invoice run, which posts it', async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO recurring_invoices(id,company_id,client_id,template_name,frequency,next_run_date,status,line_items,
         subtotal,tax_rate,tax_amount,total_amount,created_by)
       VALUES($1,$2,$3,'Dims monthly','monthly',CURRENT_DATE,'active',$4::jsonb,100,15,15,115,$5)`,
      [id, f.c, f.customer, JSON.stringify([{ description: 'Retainer', quantity: 1, unitPrice: 100 }]), user]);
    const invoiceId = await inRequest(f.c, () => generateInvoiceFromRecurring(f.c, id, user));
    expect(await fnosOf(invoiceId)).toEqual({ lines: [f.fno], posted: [f.fno] });
  });

  it('the recurring-transaction template, which posts it', async () => {
    const f = await fixture();
    const account = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'default_revenue'", [f.c])).rows[0].id;
    const templateData = { clientId: f.customer, lines: [{ description: 'Hosting', quantity: 1, unitPrice: 100, taxRate: 15, glAccountId: account }] };
    const t = (await pool.query(
      `INSERT INTO recurring_transaction_templates(company_id,name,entity_type,template_data,frequency,auto_post,created_by)
       VALUES($1,'Dims hosting','customer_invoice',$2::jsonb,'monthly',true,$3) RETURNING id`,
      [f.c, JSON.stringify(templateData), user])).rows[0].id as string;
    const { entityId, posted } = await inRequest(f.c, () => mintRecurringCustomerInvoice(f.c, {
      id: t, companyId: f.c, name: 'Dims hosting', entityType: 'customer_invoice', templateData, frequency: 'monthly',
      nextRunDate: null, lastRunDate: null, isActive: true, autoPost: true, createdBy: user, createdAt: '',
    }, user));
    expect(posted).toBe(true);
    expect(await fnosOf(entityId)).toEqual({ lines: [f.fno], posted: [f.fno] });
  });

  it('the Sage import, which posts it', async () => {
    const f = await fixture();
    const out = await inRequest(f.c, () => commitARInvoice(f.c, user, {
      invoiceNumber: `DIMS-SAGE-${f.c.slice(0, 6)}`, customerName: f.name, invoiceDate: '2026-09-01',
      subtotal: 100, taxAmount: 15, totalAmount: 115,
    }));
    expect(await fnosOf(out.invoiceId)).toEqual({ lines: [f.fno], posted: [f.fno] });
  });
});
