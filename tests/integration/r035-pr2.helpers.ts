/**
 * R-035 PR2 fixture: a company that can actually POST a supplier invoice (the
 * three system accounts and an open 2026 year), enforcement planted or switched
 * on through the real API, and the real routes a person drives — approve, bulk
 * approve, raise, decide, edit.
 */
import type { Pool } from 'pg';
import { SignJWT } from 'jose';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import supplierInvoicesBulk from '../../pages/api/accounting/supplier-invoices-bulk-action';
import supplierInvoicesDetail from '../../pages/api/accounting/supplier-invoices-detail';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { callRoute, cleanup, newCompany } from './r035-approval.helpers';

type Tokens = Record<string, string>;

/** newCompany plus what a posting needs: payable, vat_input, default_expense and an open 2026. */
export async function postableCompany(pool: Pool, members: [string, string][], companies: string[]): Promise<string> {
  const company = await newCompany(pool, members, companies);
  const tag = company.slice(0, 6);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,'AP${tag}','R035 AP','liability','credit',true,true,'payable'),
            ($1,'VI${tag}','R035 VAT input','asset','debit',true,true,'vat_input'),
            ($1,'EX${tag}','R035 Expense','expense','debit',true,true,'default_expense')`, [company]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'R035 2026',1,2026,'2026-01-01','2026-12-31','open')`, [company]);
  clearSystemAccountCache(company);
  return company;
}

/** Enforcement planted directly (the API is exercised by its own test). */
export async function enforce(pool: Pool, company: string, by: string, enabledAt?: string): Promise<void> {
  await pool.query(
    `INSERT INTO approval_enforcement(company_id, document_type, enabled_by, enabled_at)
     VALUES($1,'supplier_invoice',$2,COALESCE($3::TIMESTAMPTZ, now()))`, [company, by, enabledAt ?? null]);
}

export function routes(tokens: Tokens) {
  const as = (user: string) => tokens[user]!;
  const digestOf = async (pool: Pool, requestId: string) => (await pool.query(
    'SELECT document_digest FROM approval_requests WHERE id = $1', [requestId])).rows[0]?.document_digest as string;
  return {
    approveBill: (user: string, company: string, invoiceId: string) => callRoute(
      supplierInvoicesAction, as(user), company, 'POST', { action: 'approve', invoiceId },
      '/api/accounting/supplier-invoices-action'),
    bulk: (user: string, company: string, action: string, invoiceIds: string[]) => callRoute(
      supplierInvoicesBulk, as(user), company, 'POST', { action, invoiceIds },
      '/api/accounting/supplier-invoices-bulk-action'),
    editBill: (user: string, company: string, body: Record<string, unknown>) => callRoute(
      supplierInvoicesDetail, as(user), company, 'PUT', body, '/api/accounting/supplier-invoices-detail'),
    getBill: (user: string, company: string, id: string) => callRoute(
      supplierInvoicesDetail, as(user), company, 'GET', undefined, '/api/accounting/supplier-invoices-detail', { id }),
    raise: (user: string, company: string, documentId: string) => callRoute(
      approvalRequests, as(user), company, 'POST', { action: 'request', documentType: 'supplier_invoice', documentId },
      '/api/accounting/approval-requests'),
    decide: async (pool: Pool, user: string, company: string, requestId: string, action: 'approve' | 'reject' = 'approve') =>
      callRoute(approvalRequests, as(user), company, 'POST',
        { action, requestId, expectedDigest: await digestOf(pool, requestId) }, '/api/accounting/approval-requests'),
  };
}

export const dataOf = <T = Record<string, unknown>>(res: { state: { body: unknown } }) =>
  (res.state.body as { data: T }).data;
export const messageOf = (res: { state: { body: unknown } }) =>
  (res.state.body as { error?: { message?: string } }).error?.message ?? '';

/** A token whose GoTrue session is recorded as a platform admin's "Login as" (R-032). */
export async function impersonationToken(pool: Pool, targetUser: string, actorUser: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)',
    [sessionId, actorUser, targetUser]);
  return new SignJWT({ sub: targetUser, aal: 'aal2', session_id: sessionId })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

export async function billState(pool: Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT si.status, si.gl_journal_entry_id,
            (SELECT count(*)::INT FROM gl_journal_entries je
              WHERE je.company_id = si.company_id AND je.source = 'auto_supplier_invoice'
                AND je.description = 'Supplier invoice ' || si.invoice_number) AS journals
     FROM supplier_invoices si WHERE si.id = $1`, [id]);
  return rows[0] as { status: string; gl_journal_entry_id: string | null; journals: number };
}

/** Journals, balances and periods first — the PR1 cleanup deletes accounts they reference. */
export async function cleanupPr2(pool: Pool, companies: string[], users: string[]): Promise<void> {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [users]);
  await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))',
    [companies]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [companies]);
  await pool.query(
    'DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1))', [companies]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [companies]);
  for (const company of companies) clearSystemAccountCache(company);
  await cleanup(pool, companies, users);
}
