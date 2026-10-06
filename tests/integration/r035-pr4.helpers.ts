/**
 * R-035 PR4 fixture: a company that can POST a customer invoice (receivable,
 * default_revenue, vat_output and an open 2026), DRAFT invoices planted with a
 * customer of their own and two lines, enforcement planted for
 * `customer_invoice`, and the real routes a person drives — approve, edit and
 * read (customer-invoices-detail), merge (customer-merge), raise and decide
 * (approval-requests).
 */
import type { Pool, PoolClient } from 'pg';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import customerMerge from '../../pages/api/accounting/customer-merge';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { callRoute, newCompany } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr3 } from './r035-pr3.helpers';

type Tokens = Record<string, string>;

const ACCOUNTS: [string, string, string, string][] = [
  ['RV', 'revenue', 'default_revenue', 'credit'], ['AR', 'asset', 'receivable', 'debit'],
  ['VO', 'liability', 'vat_output', 'credit'],
];

/** newCompany plus what posting a customer invoice needs. */
export async function invoiceCompany(pool: Pool, members: [string, string][], companies: string[]): Promise<string> {
  const company = await newCompany(pool, members, companies);
  const tag = company.slice(0, 6);
  for (const [code, type, subtype, normal] of ACCOUNTS) {
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
       VALUES ($1,$2,$3,$4,$5,true,true,$6)`, [company, `${code}${tag}`, `R035 ${subtype}`, type, normal, subtype]);
  }
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R035 2026',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  clearSystemAccountCache(company);
  return company;
}

export async function enforceInvoices(pool: Pool, company: string, by: string, enabledAt?: string): Promise<void> {
  await pool.query(
    `INSERT INTO approval_enforcement(company_id, document_type, enabled_by, enabled_at)
     VALUES($1,'customer_invoice',$2,COALESCE($3::TIMESTAMPTZ, now()))`, [company, by, enabledAt ?? null]);
}

export interface Invoice { id: string; customerId: string; number: string }

/**
 * A DRAFT invoice of R1 150 (1 000 + 15% VAT) for its own customer, with two
 * lines. `total`/`functionalTotal`/`currencyCode`/`exchangeRate` let a case
 * plant a foreign-currency invoice.
 */
export async function plantInvoice(db: Pool | PoolClient, company: string, createdBy: string, opts: {
  total?: number; subtotal?: number; tax?: number; functionalTotal?: number | null; currencyCode?: string;
  exchangeRate?: number; status?: string;
} = {}): Promise<Invoice> {
  const id = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const number = `CI-${id.slice(0, 8)}`;
  await db.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customerId, company, `r035 ${id.slice(0, 6)}`]);
  await db.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,
       tax_rate,tax_amount,total_amount,functional_total,currency_code,exchange_rate,status,created_by)
     VALUES($1,$2,$3,$4,$4,DATE '2026-09-01',DATE '2026-10-01',$5,15,$6,$7,$8,$9,$10,$11,$12)`,
    [id, company, number, customerId, opts.subtotal ?? 1000, opts.tax ?? 150, opts.total ?? 1150,
      opts.functionalTotal === undefined ? null : opts.functionalTotal, opts.currencyCode ?? 'ZAR',
      opts.exchangeRate ?? 1, opts.status ?? 'draft', createdBy]);
  await db.query(
    `INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate,currency_code)
     VALUES($1,'Line A',2,300,600,15,'ZAR'),($1,'Line B',1,400,400,15,'ZAR')`, [id]);
  return { id, customerId, number };
}

/** The invoice, its journal link and how many auto_invoice journals name it (draft or posted). */
export async function invoiceState(pool: Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT ci.status, ci.gl_journal_entry_id,
            (SELECT count(*)::INT FROM gl_journal_entries je
              WHERE je.company_id = ci.company_id AND je.source = 'auto_invoice'
                AND je.description = 'Customer invoice ' || ci.invoice_number) AS journals
     FROM customer_invoices ci WHERE ci.id = $1`, [id]);
  return rows[0] as { status: string; gl_journal_entry_id: string | null; journals: number };
}

export const digestOf = async (db: Pool | PoolClient, company: string, id: string) => (await db.query(
  "SELECT approval_document_digest($1,'customer_invoice',$2) AS d", [company, id])).rows[0].d as string | null;

export function invoiceRoutes(tokens: Tokens) {
  const as = (user: string) => tokens[user]!;
  const requestDigest = async (pool: Pool, requestId: string) => (await pool.query(
    'SELECT document_digest FROM approval_requests WHERE id = $1', [requestId])).rows[0]?.document_digest as string;
  const r = {
    approve: (user: string, company: string, id: string) => callRoute(
      customerInvoicesDetail, as(user), company, 'POST', { id, action: 'approve' }, '/api/accounting/customer-invoices-detail'),
    edit: (user: string, company: string, body: Record<string, unknown>) => callRoute(
      customerInvoicesDetail, as(user), company, 'PUT', body, '/api/accounting/customer-invoices-detail'),
    get: (user: string, company: string, id: string) => callRoute(
      customerInvoicesDetail, as(user), company, 'GET', undefined, '/api/accounting/customer-invoices-detail', { id }),
    merge: (user: string, company: string, sourceId: string, targetId: string) => callRoute(
      customerMerge, as(user), company, 'POST', { source_id: sourceId, target_id: targetId }, '/api/accounting/customer-merge'),
    raise: (user: string, company: string, documentId: string) => callRoute(
      approvalRequests, as(user), company, 'POST', { action: 'request', documentType: 'customer_invoice', documentId },
      '/api/accounting/approval-requests'),
    decide: async (pool: Pool, user: string, company: string, requestId: string, action: 'approve' | 'reject' = 'approve') =>
      callRoute(approvalRequests, as(user), company, 'POST',
        { action, requestId, expectedDigest: await requestDigest(pool, requestId) }, '/api/accounting/approval-requests'),
    /** `requester` raises, `approver` approves; both must answer 200. Returns the request id. */
    approvedBy: async (pool: Pool, requester: string, approver: string, company: string, id: string): Promise<string> => {
      const raised = await r.raise(requester, company, id);
      if (raised.state.statusCode !== 200) throw new Error(`raise: ${JSON.stringify(raised.state.body)}`);
      const requestId = dataOf<{ id: string }>(raised).id;
      const decided = await r.decide(pool, approver, company, requestId);
      if (decided.state.statusCode !== 200) throw new Error(`decide: ${JSON.stringify(decided.state.body)}`);
      return requestId;
    },
  };
  return r;
}

/** Run `fn` as app_user under `sub`'s claims in one transaction, committed unless it throws. */
export async function asAppUser<T>(pool: Pool, sub: string, companyId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role: 'authenticated' })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Everything a customer invoice drags in, then PR3's teardown (notes, MCP calls, journals, periods, accounts, companies, users). */
export async function cleanupPr4(pool: Pool, companies: string[], users: string[]): Promise<void> {
  await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM customer_write_offs WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ANY($1))',
    [companies]);
  await pool.query('DELETE FROM customer_payments WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM customer_quote_lines WHERE quote_id IN (SELECT id FROM customer_quotes WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM customer_quotes WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM customer_sales_order_items WHERE sales_order_id IN (SELECT id FROM customer_sales_orders WHERE company_id = ANY($1))',
    [companies]);
  await pool.query('DELETE FROM customer_sales_orders WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM recurring_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM sage_customer_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM gl_migration_runs WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM migration_sessions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM company_document_numbers WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ANY($1))',
    [companies]);
  await pool.query('DELETE FROM time_entries WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM practice_clients WHERE company_id = ANY($1)', [companies]);
  await cleanupPr3(pool, companies, users);
}
