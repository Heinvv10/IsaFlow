/**
 * Customer Statement API
 * GET /api/accounting/customer-statement
 *   Params:
 *     customerId  — required UUID
 *     fromDate    — YYYY-MM-DD (optional, defaults to 1 year ago)
 *     toDate      — YYYY-MM-DD (optional, defaults to today)
 *     format      — 'json' (default) | 'pdf'  (streams PDF)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withCompany,
  type CompanyApiRequest,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
} from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { buildStatementHtml } from '@/modules/accounting/utils/customerStatementHtml';

type Row = Record<string, unknown>;

interface StatementTransaction {
  id: string;
  date: string;
  type: 'invoice' | 'payment' | 'credit_note';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

/** Normalize any date value to YYYY-MM-DD */
function toISODate(val: unknown): string {
  if (!val) return '1970-01-01';
  if (val instanceof Date) return val.toISOString().split('T')[0] ?? '1970-01-01';
  const s = String(val);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '1970-01-01' : (d.toISOString().split('T')[0] ?? '1970-01-01');
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { customerId, fromDate, toDate, format } = req.query;

  if (!customerId || typeof customerId !== 'string') {
    return apiResponse.badRequest(res, 'customerId is required');
  }

  const today = new Date().toISOString().split('T')[0] as string;
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
  const from = typeof fromDate === 'string' && fromDate ? fromDate : oneYearAgo;
  const to = typeof toDate === 'string' && toDate ? toDate : today;

  try {
    const customerRows = await sql`
      SELECT id, name, email, phone, billing_address AS address
      FROM customers
      WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID
    ` as Row[];

    if (customerRows.length === 0) {
      return apiResponse.notFound(res, 'Customer', customerId);
    }
    const customer = customerRows[0]!;

    const invoices = await sql`
      SELECT id, invoice_number, invoice_date, total_amount, status
      FROM customer_invoices
      WHERE client_id   = ${customerId}::UUID
        AND company_id  = ${companyId}::UUID
        AND status     != 'cancelled'
        AND invoice_date BETWEEN ${from}::DATE AND ${to}::DATE
      ORDER BY invoice_date
    ` as Row[];

    const payments = await sql`
      SELECT cp.id, cp.payment_number, cp.payment_date, cp.bank_reference,
        COALESCE(SUM(cpa.amount_allocated), cp.total_amount) AS amount_allocated
      FROM customer_payments cp
      LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
      WHERE cp.client_id   = ${customerId}::UUID
        AND cp.company_id  = ${companyId}::UUID
        AND cp.status IN ('confirmed', 'reconciled')
        AND cp.payment_date BETWEEN ${from}::DATE AND ${to}::DATE
      GROUP BY cp.id, cp.payment_number, cp.payment_date, cp.bank_reference, cp.total_amount
    ` as Row[];

    const creditNotes = await sql`
      SELECT id, credit_note_number, credit_date, reason, total_amount
      FROM credit_notes
      WHERE client_id  = ${customerId}::UUID
        AND company_id = ${companyId}::UUID
        AND type       = 'customer'
        AND status     = 'approved'
        AND credit_date BETWEEN ${from}::DATE AND ${to}::DATE
    ` as Row[];

    const transactions: StatementTransaction[] = [];

    for (const inv of invoices) {
      transactions.push({
        id: String(inv.id), date: toISODate(inv.invoice_date), type: 'invoice',
        reference: String(inv.invoice_number), description: '',
        debit: Number(inv.total_amount), credit: 0, balance: 0,
      });
    }

    for (const pmt of payments) {
      transactions.push({
        id: String(pmt.id), date: toISODate(pmt.payment_date), type: 'payment',
        reference: String(pmt.payment_number),
        description: pmt.bank_reference ? String(pmt.bank_reference) : '',
        debit: 0, credit: Number(pmt.amount_allocated), balance: 0,
      });
    }

    for (const cn of creditNotes) {
      transactions.push({
        id: String(cn.id), date: toISODate(cn.credit_date), type: 'credit_note',
        reference: String(cn.credit_note_number),
        description: cn.reason ? String(cn.reason) : '',
        debit: 0, credit: Number(cn.total_amount), balance: 0,
      });
    }

    const typeOrder: Record<string, number> = { invoice: 0, credit_note: 1, payment: 2 };
    transactions.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
    });

    let runningBalance = 0;
    let totalInvoiced = 0;
    let totalPaid = 0;
    let totalCredits = 0;

    for (const txn of transactions) {
      runningBalance += txn.debit - txn.credit;
      txn.balance = runningBalance;
      totalInvoiced += txn.debit;
      if (txn.type === 'payment') totalPaid += txn.credit;
      if (txn.type === 'credit_note') totalCredits += txn.credit;
    }

    const summary = { totalInvoiced, totalPaid, totalCredits, balance: runningBalance };
    const clientData = {
      id: String(customer.id), name: String(customer.name),
      email: customer.email ? String(customer.email) : null,
      phone: customer.phone ? String(customer.phone) : null,
      address: customer.address ? String(customer.address) : null,
    };

    if (format === 'pdf') {
      let companyName = '';
      let companyVatNumber = '';
      try {
        const settingsRows = await sql`
          SELECT key, value FROM accounting_settings WHERE company_id = ${companyId}::UUID
            AND key IN ('company_name', 'company_vat_number')
        ` as Row[];
        companyName = String(settingsRows.find(r => r.key === 'company_name')?.value ?? '');
        companyVatNumber = String(settingsRows.find(r => r.key === 'company_vat_number')?.value ?? '');
      } catch { /* ignore — use empty defaults */ }

      const html = buildStatementHtml(clientData, transactions, summary, from, to, companyName, companyVatNumber);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="statement-${clientData.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html"`);
      return res.status(200).send(html);
    }

    log.info('Customer statement fetched', { customerId, from, to, txnCount: transactions.length }, 'accounting');

    return apiResponse.success(res, {
      customer: clientData,
      fromDate: from,
      toDate: to,
      transactions,
      summary,
    });
  } catch (err) {
    log.error('Failed to fetch customer statement', { customerId, error: err }, 'accounting');
    return apiResponse.databaseError(res, err, 'Failed to fetch customer statement');
  }
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
