/**
 * R-035 PR4 review F1: an invoice minted from someone else's content carries
 * that content's authors, so they cannot approve it.
 *
 * A recurring template (recurring-invoices, recurring-transactions), a quote,
 * a sales order and logged time are content a person wrote. The user who ran
 * the schedule or clicked Convert only minted it. Before this, the minted
 * invoice's authors were the minter alone: the template's pricer could approve
 * the R115 000 invoice someone else's run minted from their price. Now the
 * template's creator and every editor whose change moved what it bills
 * (`content_authors`), the quote's and sales order's creator and the users who
 * logged the time are unioned into the invoice's content_authors before any
 * request is raised — and are refused as approvers while another eligible
 * approver exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import recurringInvoices from '../../pages/api/accounting/recurring-invoices';
import recurringRun from '../../pages/api/accounting/recurring-invoices-run';
import recurringTxns from '../../pages/api/accounting/recurring-transactions';
import recurringExecute from '../../pages/api/accounting/recurring-transactions-execute';
import customerQuotes from '../../pages/api/accounting/customer-quotes';
import customerQuotesAction from '../../pages/api/accounting/customer-quotes-action';
import timeEntriesInvoice from '../../pages/api/accounting/time-entries-invoice';
import { convertSalesOrderToInvoice } from '../../src/modules/accounting/services/ar/salesOrderWorkflowService';
import { generateWipInvoice } from '../../src/modules/accounting/services/practice/practiceWipService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceRoutes } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** runner: admin who runs / converts; author: owner who wrote the content; other: a second owner. */
const u = { runner: '', author: '', other: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, Object.values(u)));

async function fixture(): Promise<{ c: string; customer: string }> {
  const c = await invoiceCompany(pool, [[u.runner, 'admin'], [u.author, 'owner'], [u.other, 'owner']], companies);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 1000 });
  await enforceInvoices(pool, c, u.other);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 upstream')", [customer, c]);
  return { c, customer };
}

const as = (user: string, c: string, handler: never, method: string, body: unknown, url: string) =>
  callRoute(handler, tokens[user]!, c, method, body, url);
const authorsOf = async (invoiceId: string) => ((await pool.query(
  'SELECT content_authors::TEXT[] AS a FROM customer_invoices WHERE id = $1', [invoiceId])).rows[0].a as string[]).sort();

/** The runner raises; the author is refused 403 as an author; the other owner approves. */
async function authorRefusedOtherApproves(c: string, invoiceId: string): Promise<void> {
  const raised = await r.raise(u.runner, c, invoiceId);
  const requestId = raised.state.statusCode === 200 ? dataOf<{ id: string }>(raised).id
    : (await pool.query("SELECT id FROM approval_requests WHERE document_id = $1 AND status = 'pending'", [invoiceId])).rows[0].id;
  const refused = await r.decide(pool, u.author, c, requestId);
  expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(403);
  expect(messageOf(refused)).toMatch(/you authored the content/);
  expect((await r.decide(pool, u.other, c, requestId)).state.statusCode).toBe(200);
}

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

describe('recurring invoices (recurring-invoices + run)', () => {
  it('the editor who re-priced the template is an author of the invoice the runner minted', async () => {
    const { c, customer } = await fixture();
    const created = await as(u.runner, c, recurringInvoices as never, 'POST', {
      templateName: 'R035 retainer', clientId: customer, frequency: 'monthly', nextRunDate: yesterday(),
      lineItems: [{ description: 'Retainer', quantity: 1, unitPrice: 100 }], taxRate: 15,
    }, '/api/accounting/recurring-invoices');
    const templateId = dataOf<{ id: string }>(created).id;
    expect((await as(u.author, c, recurringInvoices as never, 'PUT', {
      id: templateId, lineItems: [{ description: 'Retainer', quantity: 1, unitPrice: 100_000 }], taxRate: 15,
    }, '/api/accounting/recurring-invoices')).state.statusCode).toBe(200);
    // A PUT that changes nothing billed (the name) stamps nobody.
    await as(u.other, c, recurringInvoices as never, 'PUT', { id: templateId, templateName: 'renamed' }, '/api/accounting/recurring-invoices');
    // The creator is stamped on create, the re-pricer on the PUT that moved what it bills.
    const { rows: [t] } = await pool.query('SELECT content_authors::TEXT[] AS a FROM recurring_invoices WHERE id = $1', [templateId]);
    expect(t.a).toEqual([u.runner, u.author]);

    const ran = await as(u.runner, c, recurringRun as never, 'POST', {}, '/api/accounting/recurring-invoices-run');
    const invoiceId = dataOf<{ held_for_approval: string[] }>(ran).held_for_approval[0]!;
    expect(await authorsOf(invoiceId)).toEqual([u.runner, u.author].sort());
    await authorRefusedOtherApproves(c, invoiceId);
  });

  it("the template's creator is an author of every invoice it mints", async () => {
    const { c, customer } = await fixture();
    await as(u.author, c, recurringInvoices as never, 'POST', {
      templateName: 'R035 big retainer', clientId: customer, frequency: 'monthly', nextRunDate: yesterday(),
      lineItems: [{ description: 'Retainer', quantity: 1, unitPrice: 100_000 }], taxRate: 15,
    }, '/api/accounting/recurring-invoices');
    const ran = await as(u.runner, c, recurringRun as never, 'POST', {}, '/api/accounting/recurring-invoices-run');
    const invoiceId = dataOf<{ held_for_approval: string[] }>(ran).held_for_approval[0]!;
    expect(await authorsOf(invoiceId)).toEqual([u.author]);
    await authorRefusedOtherApproves(c, invoiceId);
  });
});

describe('the customer merge', () => {
  it('re-pointing a template at another customer makes the merging user an author of both kinds of template', async () => {
    const { c, customer } = await fixture();
    const target = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 merge target')", [target, c]);
    const ri = dataOf<{ id: string }>(await as(u.runner, c, recurringInvoices as never, 'POST', {
      templateName: 'R035 merge', clientId: customer, frequency: 'monthly', nextRunDate: yesterday(),
      lineItems: [{ description: 'Retainer', quantity: 1, unitPrice: 100 }], taxRate: 15,
    }, '/api/accounting/recurring-invoices')).id;
    const rt = dataOf<{ id: string }>(await as(u.runner, c, recurringTxns as never, 'POST', {
      name: 'R035 merge AR', entityType: 'customer_invoice', frequency: 'monthly', templateData: { clientId: customer },
    }, '/api/accounting/recurring-transactions')).id;
    expect((await r.merge(u.author, c, customer, target)).state.statusCode).toBe(200);
    const { rows } = await pool.query(
      `SELECT content_authors::TEXT[] AS a FROM recurring_invoices WHERE id = $1
       UNION ALL SELECT content_authors::TEXT[] FROM recurring_transaction_templates WHERE id = $2`, [ri, rt]);
    expect(rows.map((x) => x.a)).toEqual([[u.runner, u.author], [u.runner, u.author]]);
  });
});

describe('recurring transactions (autoPost)', () => {
  const data = (customer: string, price: number) => ({ clientId: customer, subtotal: price, vatAmount: price * 0.15,
    totalAmount: price * 1.15, lines: [{ description: 'Retainer', quantity: 1, unitPrice: price, taxRate: 15, lineTotal: price }] });

  it("the template's creator and its re-pricer are authors of the invoice another user's run minted", async () => {
    const { c, customer } = await fixture();
    const created = await as(u.runner, c, recurringTxns as never, 'POST', {
      name: 'R035 AR auto', entityType: 'customer_invoice', frequency: 'monthly', autoPost: true,
      nextRunDate: new Date().toISOString().slice(0, 10), templateData: data(customer, 100),
    }, '/api/accounting/recurring-transactions');
    const templateId = dataOf<{ id: string }>(created).id;
    expect((await as(u.author, c, recurringTxns as never, 'PUT', { id: templateId, templateData: data(customer, 100_000) },
      '/api/accounting/recurring-transactions')).state.statusCode).toBe(200);
    const { rows: [t] } = await pool.query('SELECT content_authors::TEXT[] AS a FROM recurring_transaction_templates WHERE id = $1', [templateId]);
    expect(t.a).toEqual([u.runner, u.author]);

    const ran = await as(u.other, c, recurringExecute as never, 'POST', { templateId }, '/api/accounting/recurring-transactions-execute');
    const invoiceId = dataOf<{ entityId: string; posted: boolean }>(ran).entityId;
    expect(await authorsOf(invoiceId)).toEqual([u.runner, u.author].sort());
  });
});

describe('conversions', () => {
  it("quote → invoice: the quote's author is refused as the approver of the invoice the converter minted", async () => {
    const { c, customer } = await fixture();
    const quote = dataOf<{ id: string }>(await as(u.author, c, customerQuotes as never, 'POST', {
      clientId: customer, quoteDate: '2026-09-01', lines: [{ description: 'Build', quantity: 1, unitPrice: 100_000, taxRate: 15 }],
    }, '/api/accounting/customer-quotes'));
    await as(u.runner, c, customerQuotesAction as never, 'POST', { id: quote.id, action: 'accept' }, '/api/accounting/customer-quotes-action');
    const converted = await as(u.runner, c, customerQuotesAction as never, 'POST', { id: quote.id, action: 'convert' },
      '/api/accounting/customer-quotes-action');
    expect(converted.state.statusCode, JSON.stringify(converted.state.body)).toBe(200);
    const invoiceId = (dataOf<{ invoiceId?: string; id?: string }>(converted).invoiceId)!;
    expect(await authorsOf(invoiceId)).toEqual([u.author]);
    await authorRefusedOtherApproves(c, invoiceId);
  });

  async function inRequest<T>(c: string, user: string, fn: () => Promise<T>): Promise<T> {
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

  it("sales order → invoice: the order's creator is an author", async () => {
    const { c, customer } = await fixture();
    const order = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customer_sales_orders(id,company_id,order_number,customer_id,order_date,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,$2,$3,$4,DATE '2026-09-01',1000,150,1150,'confirmed',$5)`, [order, c, `SO-${order.slice(0, 6)}`, customer, u.author]);
    await pool.query(
      `INSERT INTO customer_sales_order_items(sales_order_id,description,quantity,unit_price,tax_rate,line_total)
       VALUES($1,'Goods',1,1000,15,1000)`, [order]);
    const { invoiceId } = await inRequest(c, u.runner, () => convertSalesOrderToInvoice(c, order, u.runner));
    expect(await authorsOf(invoiceId)).toEqual([u.author]);
  });

  async function timeEntry(c: string, loggedBy: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,rate,billable,invoiced,status,
         practice_client_id,applied_rate,line_total,origin)
       VALUES($1,$2,$3,'Fieldwork',DATE '2026-09-01',4,250,true,false,$4,$5,250,1000,'manual')`,
      [id, c, loggedBy, extra.status ?? 'draft', extra.practiceClientId ?? null]);
    return id;
  }

  it('time entries → invoice: every user who logged an entry is an author', async () => {
    const { c, customer } = await fixture();
    const ids = [await timeEntry(c, u.author), await timeEntry(c, u.other)];
    const res = await as(u.runner, c, timeEntriesInvoice as never, 'POST', { timeEntryIds: ids, customerId: customer },
      '/api/accounting/time-entries-invoice');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    expect(await authorsOf(dataOf<{ invoiceId: string }>(res).invoiceId)).toEqual([u.author, u.other].sort());
  });

  it('WIP billing → invoice: every user who logged an entry is an author', async () => {
    const { c, customer } = await fixture();
    const practiceClientId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
       VALUES($1,$2,'R035 practice client','hourly','active',$3)`, [practiceClientId, c, customer]);
    const ids = [await timeEntry(c, u.author, { status: 'approved', practiceClientId })];
    const out = await inRequest(c, u.runner, () => generateWipInvoice(c, u.runner, { practiceClientId, timeEntryIds: ids }));
    expect(await authorsOf(out.invoiceId)).toEqual([u.author]);
  });
});
