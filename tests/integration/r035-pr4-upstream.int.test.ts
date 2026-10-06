/**
 * R-035 PR4 review F1: an invoice minted from a RECURRING TEMPLATE carries the
 * template's authors, so they cannot approve it.
 *
 * A template (recurring-invoices, recurring-transactions) is content a person
 * wrote; the user who ran the schedule only minted it. Before this, the minted
 * invoice's authors were the runner alone: the template's pricer could approve
 * the R115 000 invoice someone else's run minted from their price. A template
 * now records its creator and every editor whose change moved what it bills
 * (`content_authors`: create, the PUT / update, the customer merge), and both
 * are written into the minted invoice's content_authors before any request is
 * raised. Conversions (quote, sales order, time) are derived instead:
 * r035-pr4-conversions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import recurringInvoices from '../../pages/api/accounting/recurring-invoices';
import recurringRun from '../../pages/api/accounting/recurring-invoices-run';
import recurringTxns from '../../pages/api/accounting/recurring-transactions';
import recurringExecute from '../../pages/api/accounting/recurring-transactions-execute';
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

describe('templates from before migration 865', () => {
  it("a template's created_by is an author even with no content_authors recorded", async () => {
    const { c, customer } = await fixture();
    await pool.query(
      `INSERT INTO recurring_invoices(company_id,template_name,client_id,frequency,next_run_date,line_items,subtotal,tax_rate,
         tax_amount,total_amount,created_by,status)
       VALUES($1,'R035 legacy',$2,'monthly',CURRENT_DATE - 1,$3::jsonb,100000,15,15000,115000,$4,'active')`,
      [c, customer, JSON.stringify([{ description: 'Retainer', quantity: 1, unitPrice: 100_000 }]), u.author]);
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,next_run_date,auto_post,created_by)
       VALUES($1,$2,'R035 legacy AR','customer_invoice',$3,'monthly',CURRENT_DATE,true,$4)`,
      [id, c, JSON.stringify({ clientId: customer, subtotal: 100_000, vatAmount: 15_000, totalAmount: 115_000,
        lines: [{ description: 'Retainer', quantity: 1, unitPrice: 100_000, taxRate: 15, lineTotal: 100_000 }] }), u.author]);
    const ran = await as(u.runner, c, recurringRun as never, 'POST', {}, '/api/accounting/recurring-invoices-run');
    expect(await authorsOf(dataOf<{ held_for_approval: string[] }>(ran).held_for_approval[0]!)).toEqual([u.author]);
    const executed = await as(u.runner, c, recurringExecute as never, 'POST', { templateId: id }, '/api/accounting/recurring-transactions-execute');
    expect(await authorsOf(dataOf<{ entityId: string }>(executed).entityId)).toEqual([u.author]);
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
