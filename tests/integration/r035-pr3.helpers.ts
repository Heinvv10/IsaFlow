/**
 * R-035 PR3 fixture: a company that can POST both kinds of credit note (the
 * six system accounts and an open 2026), credit notes planted as drafts with a
 * customer or supplier of their own, enforcement planted per type, and the
 * real routes a person drives — approve (credit-notes-action), the supplier
 * create-and-post / post (supplier-credit-notes), the detail GETs, raise and
 * decide (approval-requests).
 */
import type { Pool } from 'pg';
import creditNotesAction from '../../pages/api/accounting/credit-notes-action';
import creditNotes from '../../pages/api/accounting/credit-notes';
import supplierCreditNotes from '../../pages/api/accounting/supplier-credit-notes';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { callRoute, newCompany } from './r035-approval.helpers';
import { cleanupPr2 } from './r035-pr2.helpers';

type Tokens = Record<string, string>;
export type NoteType = 'customer' | 'supplier';
export const approvalTypeOf = (type: NoteType) => (type === 'customer' ? 'customer_credit_note' : 'supplier_credit_note');

const ACCOUNTS: [string, string, string, string][] = [
  ['RV', 'revenue', 'default_revenue', 'credit'], ['AR', 'asset', 'receivable', 'debit'],
  ['VO', 'liability', 'vat_output', 'credit'], ['EX', 'expense', 'default_expense', 'debit'],
  ['AP', 'liability', 'payable', 'credit'], ['VI', 'asset', 'vat_input', 'debit'],
];

/** newCompany plus what posting either kind of note needs. */
export async function noteCompany(pool: Pool, members: [string, string][], companies: string[]): Promise<string> {
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

export async function enforceType(pool: Pool, company: string, type: NoteType, by: string, enabledAt?: string): Promise<void> {
  await pool.query(
    `INSERT INTO approval_enforcement(company_id, document_type, enabled_by, enabled_at)
     VALUES($1,$2,$3,COALESCE($4::TIMESTAMPTZ, now()))`, [company, approvalTypeOf(type), by, enabledAt ?? null]);
}

export interface Note { id: string; type: NoteType; entityId: string; invoiceId: string | null }

/**
 * A DRAFT note of R1 150 (1 000 + 15% VAT) against its own customer or
 * supplier. `linked` plants an open invoice of R5 000 for it to settle;
 * `subtotal`/`tax`/`total` let a case plant figures that do not foot.
 */
export async function plantNote(pool: Pool, company: string, createdBy: string, type: NoteType, opts: {
  linked?: boolean; subtotal?: number; tax?: number; total?: number;
} = {}): Promise<Note> {
  const id = crypto.randomUUID();
  const entityId = crypto.randomUUID();
  const table = type === 'customer' ? 'customers' : 'suppliers';
  await pool.query(`INSERT INTO ${table}(id,company_id,name) VALUES($1,$2,$3)`, [entityId, company, `r035 ${id.slice(0, 6)}`]);
  let invoiceId: string | null = null;
  if (opts.linked) {
    invoiceId = crypto.randomUUID();
    if (type === 'customer') {
      await pool.query(
        `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date)
         VALUES($1,$2,$3,$4,$4,5000,5000,0,'sent',$5,DATE '2026-08-01')`, [invoiceId, company, `INV-${id.slice(0, 8)}`, entityId, createdBy]);
    } else {
      await pool.query(
        `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date)
         VALUES($1,$2,$3,$4,5000,5000,0,'approved',$5,DATE '2026-08-01')`, [invoiceId, company, `BILL-${id.slice(0, 8)}`, entityId, createdBy]);
    }
  }
  await pool.query(
    `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,supplier_id,customer_invoice_id,supplier_invoice_id,
       credit_date,subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,DATE '2026-09-01',$9,15,$10,$11,'draft',$12)`,
    [id, company, `CN-${id.slice(0, 8)}`, type,
      type === 'customer' ? entityId : null, type === 'supplier' ? entityId : null,
      type === 'customer' ? invoiceId : null, type === 'supplier' ? invoiceId : null,
      opts.subtotal ?? 1000, opts.tax ?? 150, opts.total ?? 1150, createdBy]);
  return { id, type, entityId, invoiceId };
}

/** The note, its journal link, how many auto_credit_note journals name it (draft or posted), and its invoice's amount_paid. */
export async function noteState(pool: Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT cn.status, cn.gl_journal_entry_id,
            (SELECT count(*)::INT FROM gl_journal_entries je
              WHERE je.company_id = cn.company_id AND je.source = 'auto_credit_note'
                AND je.description = 'Credit note ' || cn.credit_note_number) AS journals,
            COALESCE((SELECT ci.amount_paid FROM customer_invoices ci WHERE ci.id = cn.customer_invoice_id),
                     (SELECT si.amount_paid FROM supplier_invoices si WHERE si.id = cn.supplier_invoice_id))::FLOAT8 AS invoice_paid
     FROM credit_notes cn WHERE cn.id = $1`, [id]);
  return rows[0] as { status: string; gl_journal_entry_id: string | null; journals: number; invoice_paid: number | null };
}

export function noteRoutes(tokens: Tokens) {
  const as = (user: string) => tokens[user]!;
  const digestOf = async (pool: Pool, requestId: string) => (await pool.query(
    'SELECT document_digest FROM approval_requests WHERE id = $1', [requestId])).rows[0]?.document_digest as string;
  return {
    /** The one approve every UI page and both note types reach. */
    approve: (user: string, company: string, creditNoteId: string) => callRoute(
      creditNotesAction, as(user), company, 'POST', { action: 'approve', creditNoteId }, '/api/accounting/credit-notes-action'),
    cancel: (user: string, company: string, creditNoteId: string) => callRoute(
      creditNotesAction, as(user), company, 'POST', { action: 'cancel', creditNoteId }, '/api/accounting/credit-notes-action'),
    postSupplier: (user: string, company: string, id: string) => callRoute(
      supplierCreditNotes, as(user), company, 'PATCH', { id, action: 'post' }, '/api/accounting/supplier-credit-notes'),
    createSupplier: (user: string, company: string, supplierId: string, submitAction: 'draft' | 'post') => callRoute(
      supplierCreditNotes, as(user), company, 'POST', {
        supplierId, creditDate: '2026-09-01', description: 'R035 PR3',
        lineItems: [{ description: 'Returned goods', quantity: 1, unitPrice: 1000, vatType: 'standard' }], submitAction,
      }, '/api/accounting/supplier-credit-notes'),
    getNote: (user: string, company: string, id: string) => callRoute(
      creditNotes, as(user), company, 'GET', undefined, '/api/accounting/credit-notes', { id }),
    getSupplierNote: (user: string, company: string, id: string) => callRoute(
      supplierCreditNotes, as(user), company, 'GET', undefined, '/api/accounting/supplier-credit-notes', { id }),
    raise: (user: string, company: string, documentType: string, documentId: string) => callRoute(
      approvalRequests, as(user), company, 'POST', { action: 'request', documentType, documentId },
      '/api/accounting/approval-requests'),
    decide: async (pool: Pool, user: string, company: string, requestId: string, action: 'approve' | 'reject' = 'approve') =>
      callRoute(approvalRequests, as(user), company, 'POST',
        { action, requestId, expectedDigest: await digestOf(pool, requestId) }, '/api/accounting/approval-requests'),
  };
}

/** Allocations and notes first (they reference journals, invoices, customers and suppliers), then PR2's teardown. */
export async function cleanupPr3(pool: Pool, companies: string[], users: string[]): Promise<void> {
  await pool.query('DELETE FROM credit_note_allocations WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM credit_notes WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = ANY($1)', [companies]);
  await cleanupPr2(pool, companies, users);
}
