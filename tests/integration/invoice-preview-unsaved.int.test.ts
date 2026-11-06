/**
 * Master plan wave 4, PR PV: POST /api/accounting/invoice-pdf-preview renders the PDF of an invoice nobody saved.
 * Through the real routes, for a company on the PAYG plan (so a create is metered):
 *
 * - ten previews leave the flow wallet, the flow ledger, the invoice-number sequence and the customer_invoices rows as
 *   they were (it never calls create, writes no invoice, meters nothing and takes no number);
 * - a preview and then a create of the same body print and store the same subtotal, VAT and total, to the cent;
 * - another company's customer is a 404;
 * - a body naming company B's job, account, item and VAT code prints none of B's names, and says the job was not
 *   recognised; a foreign currency the company has not enabled is a 400;
 * - the preview's rate-limit bucket is each member's own (300 in 15 min): one member using theirs up leaves a
 *   colleague's previews and invoice-pdf downloads working.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import invoicePdfPreview from '../../pages/api/accounting/invoice-pdf-preview';
import invoicePdf from '../../pages/api/accounting/invoice-pdf';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { clearRateLimitCache } from '@/lib/rateLimit';
import { PREVIEW_RATE_LIMIT, previewRateLimitName } from '@/modules/accounting/services/ar/invoicePreviewBody';
import { JOB_NOT_RECOGNISED } from '@/modules/accounting/services/ar/invoicePreviewModel';
import { PREVIEW_WATERMARK } from '@/modules/accounting/services/ar/invoicePdfPreviewMarks';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, newCompany } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr4, invoiceCompany, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
const users: string[] = [];
let company = '';
let customer = '';
let createdPlan: string | null = null;
const BALANCE = 100;

const preview = (body: unknown, co = company) =>
  callRoute(invoicePdfPreview, tokens[owner]!, co, 'POST', body, '/api/accounting/invoice-pdf-preview');

async function textOf(res: { state: { statusCode: number; body: unknown } }): Promise<string> {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  expect(Buffer.isBuffer(res.state.body)).toBe(true);
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: res.state.body as Buffer }).getText()).text.replace(/\s+/g, ' ');
}
/** A rand figure as the PDF prints it (fmtZAR), read back with its no-break space as a space. */
const zar = (n: number | string) => `R ${Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/** The new page's body for 3 × R10 including VAT: R8.70 a unit, R26.10 + R3.92 = R30.02 (a float price says R30.00). */
const BODY = () => ({
  clientId: customer, invoiceDate: '2026-11-06', dueDate: '', billingPeriodStart: '2026-11-06', billingPeriodEnd: '2026-11-06',
  taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '',
  items: [{ key: '1', description: 'Preview widgets', quantity: 3, unitPrice: 8.695652173913045, discount: 0, incomeType: 'other',
    glAccountId: '', projectId: '', cc2Id: '', buId: '' }],
});

const meter = async () => ({
  wallet: (await pool.query('SELECT balance_flows, month_flows_used FROM flow_wallet WHERE company_id = $1', [company])).rows,
  ledger: (await pool.query('SELECT type, flows, operation_code FROM flow_ledger WHERE company_id = $1 ORDER BY created_at, id', [company])).rows,
  numbers: (await pool.query('SELECT * FROM company_document_numbers WHERE company_id = $1 ORDER BY 1', [company])).rows,
  invoices: (await pool.query('SELECT count(*)::int AS n FROM customer_invoices WHERE company_id = $1', [company])).rows[0].n as number,
});

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  users.push(owner);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
  customer = crypto.randomUUID();
  await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'Preview Customer']);
  createdPlan = (await pool.query(
    `INSERT INTO plans (code, name) VALUES ('payg', 'Preview PAYG') ON CONFLICT (code) DO NOTHING RETURNING id`)).rows[0]?.id ?? null;
  await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status) SELECT $1, id, 'active' FROM plans WHERE code = 'payg'`, [company]);
  await pool.query(`INSERT INTO flow_wallet (company_id, balance_flows) VALUES ($1, $2)
    ON CONFLICT (company_id) DO UPDATE SET balance_flows = EXCLUDED.balance_flows, month_flows_used = 0`, [company, BALANCE]);
}, 60_000);

afterAll(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica'); // flow_ledger is append-only
    await c.query('DELETE FROM flow_ledger WHERE company_id = ANY($1)', [companies]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  await pool.query('DELETE FROM flow_wallet WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [companies]);
  if (createdPlan) await pool.query('DELETE FROM plans WHERE id = $1', [createdPlan]);
  await pool.query('DELETE FROM items WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM projects WHERE company_id = ANY($1)', [companies]);
  await pool.query(`DELETE FROM rate_limit_counters WHERE key LIKE ANY($1)`, [companies.map((id) => `%${id}%`)]);
  await cleanupPr4(pool, companies, users);
});

describe('invoice preview before the first save', () => {
  it('ten previews: no wallet debit, no number taken, no invoice written', async () => {
    const before = await meter();
    for (let i = 1; i <= 10; i++) {
      const text = await textOf(await preview({ ...BODY(), notes: `Preview ${i}` }));
      expect(text).toContain(PREVIEW_WATERMARK);
    }
    expect(await meter()).toEqual(before);
  });

  it('a preview and then a create of the same body give the same subtotal, VAT and total, to the cent', async () => {
    const text = await textOf(await preview(BODY()));
    const created = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST', BODY(), '/api/accounting/customer-invoices-create');
    expect(created.state.statusCode, JSON.stringify(created.state.body)).toBe(201);
    const { id, invoiceNumber } = dataOf<{ id: string; invoiceNumber: string }>(created);
    const [row] = (await pool.query('SELECT subtotal, tax_amount, total_amount FROM customer_invoices WHERE id = $1', [id])).rows;
    expect(row).toEqual({ subtotal: '26.10', tax_amount: '3.92', total_amount: '30.02' });
    for (const figure of [row.subtotal, row.tax_amount, row.total_amount]) expect(text).toContain(zar(figure));
    // The control: create is metered for this company, and took a number the preview never printed.
    expect((await meter()).wallet).toEqual([expect.objectContaining({ balance_flows: BALANCE - getFlowCost('invoice.create') })]);
    expect(text).not.toContain(invoiceNumber);
  });

  it('another company\'s customer is a 404', async () => {
    const other = await newCompany(pool, [[owner, 'owner']], companies);
    const theirs = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [theirs, other, 'Their Customer']);
    const res = await preview({ ...BODY(), clientId: theirs });
    expect(res.state.statusCode).toBe(404);
    expect(JSON.stringify(res.state.body)).not.toContain('Their Customer');
  });

  it('company B\'s job, account, item and VAT code: none of B\'s names is printed', async () => {
    const b = await newCompany(pool, [[owner, 'owner']], companies);
    const job = (await pool.query(`INSERT INTO projects (company_id, project_number, name) VALUES ($1, 'P-B', 'B-SECRET-JOB') RETURNING id`, [b])).rows[0].id;
    const account = (await pool.query(`INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active)
      VALUES ($1,'B-4000','B-SECRET-ACCOUNT','revenue','credit',true) RETURNING id`, [b])).rows[0].id;
    const item = (await pool.query(`INSERT INTO items (company_id, code, description, selling_price_excl) VALUES ($1, 'B-IT', 'B-SECRET-ITEM', 777.77) RETURNING id`, [b])).rows[0].id;
    const body = BODY();
    const text = await textOf(await preview({ ...body, projectId: job,
      items: [{ ...body.items[0], glAccountId: account, projectId: job, itemId: item, vatCode: 'B-SECRET-VAT' }] }));
    expect(text).not.toMatch(/B-SECRET|777\.77/);
    expect(text).toContain(JOB_NOT_RECOGNISED);
    expect(text).toContain('Preview widgets');
  });

  it('a foreign currency the company has not enabled is a 400', async () => {
    const res = await preview({ ...BODY(), currencyCode: 'USD', exchangeRate: 18.5 });
    expect(res.state.statusCode).toBe(400);
  });

  it('over 200 lines is a 400', async () => {
    const line = BODY().items[0];
    expect((await preview({ ...BODY(), items: Array.from({ length: 201 }, () => line) })).state.statusCode).toBe(400);
  });

  it('one member using up their preview limit leaves a colleague\'s previews and invoice-pdf downloads working', async () => {
    const colleague = await createUser(pool, tokens);
    users.push(colleague);
    const c = await invoiceCompany(pool, [[owner, 'owner'], [colleague, 'owner']], companies);
    const theirCustomer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [theirCustomer, c, 'Limit Customer']);
    const stored = await plantInvoice(pool, c, owner);
    clearRateLimitCache();
    // The owner's bucket one short of full (300 renders would take minutes): checkReportRateLimit stores it as
    // report:<name>:co:<company>.
    await pool.query(`INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, $2, NOW())`,
      [`report:${previewRateLimitName(owner)}:co:${c}`, PREVIEW_RATE_LIMIT.max - 1]);
    const body = { ...BODY(), clientId: theirCustomer };
    expect((await preview(body, c)).state.statusCode).toBe(200);
    expect((await preview(body, c)).state.statusCode).toBe(429);
    const theirs = await callRoute(invoicePdfPreview, tokens[colleague]!, c, 'POST', body, '/api/accounting/invoice-pdf-preview');
    expect(theirs.state.statusCode, JSON.stringify(theirs.state.body)).toBe(200);
    const download = await callRoute(invoicePdf, tokens[owner]!, c, 'GET', undefined, '/api/accounting/invoice-pdf',
      { invoiceId: stored.id, disposition: 'inline' });
    expect(download.state.statusCode, JSON.stringify(download.state.body)).toBe(200);
  }, 60_000);
});
