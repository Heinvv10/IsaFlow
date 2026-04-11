/**
 * Customer Statement API
 * GET /api/accounting/customer-statement
 *   Params:
 *     customerId  — required UUID
 *     fromDate    — YYYY-MM-DD (optional, defaults to 1 year ago)
 *     toDate      — YYYY-MM-DD (optional, defaults to today)
 *     format      — 'json' (default) | 'pdf'  (streams PDF)
 *
 * Returns: customer info + transactions (invoices + payments + credit notes)
 * sorted by date with running balance.
 *
 * When format=pdf the response streams an HTML→PDF using the same
 * generateStatementPdf utility used on the detail page.
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

  // Default date range: last 12 months
  const today = new Date().toISOString().split('T')[0] as string;
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
  const from = typeof fromDate === 'string' && fromDate ? fromDate : oneYearAgo;
  const to = typeof toDate === 'string' && toDate ? toDate : today;

  try {
    // Customer info (IDOR-safe: must belong to this company)
    const customerRows = await sql`
      SELECT id, name, email, phone, address
      FROM customers
      WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID
    ` as Row[];

    if (customerRows.length === 0) {
      return apiResponse.notFound(res, 'Customer', customerId);
    }
    const customer = customerRows[0]!;

    // Invoices in date range
    const invoices = await sql`
      SELECT id, invoice_number, invoice_date, reference, total_amount, status
      FROM customer_invoices
      WHERE client_id   = ${customerId}::UUID
        AND company_id  = ${companyId}::UUID
        AND status     != 'cancelled'
        AND invoice_date BETWEEN ${from}::DATE AND ${to}::DATE
      ORDER BY invoice_date
    ` as Row[];

    // Payments in date range
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

    // Credit notes in date range
    const creditNotes = await sql`
      SELECT id, credit_note_number, credit_date, reason, total_amount
      FROM credit_notes
      WHERE client_id  = ${customerId}::UUID
        AND company_id = ${companyId}::UUID
        AND type       = 'customer'
        AND status     = 'approved'
        AND credit_date BETWEEN ${from}::DATE AND ${to}::DATE
    ` as Row[];

    // Build unified transaction list
    const transactions: StatementTransaction[] = [];

    for (const inv of invoices) {
      transactions.push({
        id: String(inv.id),
        date: toISODate(inv.invoice_date),
        type: 'invoice',
        reference: String(inv.invoice_number),
        description: inv.reference ? String(inv.reference) : '',
        debit: Number(inv.total_amount),
        credit: 0,
        balance: 0,
      });
    }

    for (const pmt of payments) {
      transactions.push({
        id: String(pmt.id),
        date: toISODate(pmt.payment_date),
        type: 'payment',
        reference: String(pmt.payment_number),
        description: pmt.bank_reference ? String(pmt.bank_reference) : '',
        debit: 0,
        credit: Number(pmt.amount_allocated),
        balance: 0,
      });
    }

    for (const cn of creditNotes) {
      transactions.push({
        id: String(cn.id),
        date: toISODate(cn.credit_date),
        type: 'credit_note',
        reference: String(cn.credit_note_number),
        description: cn.reason ? String(cn.reason) : '',
        debit: 0,
        credit: Number(cn.total_amount),
        balance: 0,
      });
    }

    // Sort chronologically (invoices before payments on same day)
    const typeOrder: Record<string, number> = { invoice: 0, credit_note: 1, payment: 2 };
    transactions.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
    });

    // Running balance
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

    const summary = {
      totalInvoiced,
      totalPaid,
      totalCredits,
      balance: runningBalance,
    };

    const clientData = {
      id: String(customer.id),
      name: String(customer.name),
      email: customer.email ? String(customer.email) : null,
      phone: customer.phone ? String(customer.phone) : null,
      address: customer.address ? String(customer.address) : null,
    };

    // PDF format: generate and stream
    if (format === 'pdf') {
      // Fetch company settings for PDF header (best-effort)
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

      // Build HTML statement for simple PDF via puppeteer-like approach
      // Since this is server-side (no jsPDF), we return an HTML page the browser can print
      const fmtZAR = (n: number) =>
        new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
      const fmtDate = (d: string) => {
        const parts = d.split('T')[0]?.split('-') ?? [];
        return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
      };

      const typeLabels: Record<string, string> = {
        invoice: 'Invoice',
        payment: 'Payment',
        credit_note: 'Credit Note',
      };

      const rows = transactions.map(t => `
        <tr>
          <td>${fmtDate(t.date)}</td>
          <td>${typeLabels[t.type] || t.type}</td>
          <td>${t.reference}</td>
          <td>${(t.description || '').substring(0, 40)}</td>
          <td class="num">${t.debit > 0 ? fmtZAR(t.debit) : ''}</td>
          <td class="num">${t.credit > 0 ? fmtZAR(t.credit) : ''}</td>
          <td class="num bal">${fmtZAR(t.balance)}</td>
        </tr>`).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Statement — ${clientData.name}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 10px; color: #222; padding: 20mm; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .header { display: flex; justify-content: space-between; margin-bottom: 8mm; }
  .header-left .company { font-size: 12px; font-weight:bold; }
  .header-right { text-align: right; }
  .header-right .client-name { font-size: 14px; font-weight:bold; }
  .divider { border-top: 1px solid #ccc; margin: 4mm 0; }
  .summary { display: flex; gap: 8mm; margin-bottom: 6mm; padding: 4mm; background:#f5f7fa; border-radius:4px; }
  .summary-box { flex: 1; text-align: center; }
  .summary-box .label { font-size: 8px; color:#666; text-transform: uppercase; }
  .summary-box .value { font-size: 13px; font-weight:bold; }
  table { width:100%; border-collapse: collapse; margin-top: 4mm; }
  th { background:#1a3a6b; color:#fff; padding: 4px 6px; text-align:left; font-size:9px; }
  td { padding: 3px 6px; border-bottom: 1px solid #eee; font-size: 9px; }
  tr:nth-child(even) td { background: #f8fafc; }
  .num { text-align:right; font-family: monospace; }
  .bal { font-weight:bold; }
  .footer { margin-top: 8mm; font-size: 8px; color: #999; border-top: 1px solid #eee; padding-top: 3mm; }
  @media print { @page { size: A4 portrait; margin: 15mm; } body { padding:0; } }
</style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <h1>STATEMENT</h1>
    ${companyName ? `<div class="company">${companyName}</div>` : ''}
    ${companyVatNumber ? `<div>VAT No: ${companyVatNumber}</div>` : ''}
  </div>
  <div class="header-right">
    <div class="client-name">${clientData.name}</div>
    ${clientData.email ? `<div>${clientData.email}</div>` : ''}
    ${clientData.phone ? `<div>${clientData.phone}</div>` : ''}
    <div style="margin-top:4px">Period: ${from} to ${to}</div>
    <div>Generated: ${new Date().toLocaleDateString('en-ZA')}</div>
  </div>
</div>
<div class="divider"></div>
<div class="summary">
  <div class="summary-box"><div class="label">Total Invoiced</div><div class="value">${fmtZAR(totalInvoiced)}</div></div>
  <div class="summary-box"><div class="label">Total Paid</div><div class="value">${fmtZAR(totalPaid)}</div></div>
  <div class="summary-box"><div class="label">Credits Applied</div><div class="value">${fmtZAR(totalCredits)}</div></div>
  <div class="summary-box"><div class="label">Balance Due</div><div class="value" style="color:${runningBalance > 0 ? '#b43232' : '#16a34a'}">${fmtZAR(runningBalance)}</div></div>
</div>
<table>
  <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:8px">No transactions in this period</td></tr>'}</tbody>
</table>
<div class="footer">ISAFlow Customer Statement — Confidential &nbsp;|&nbsp; ${clientData.name} &nbsp;|&nbsp; ${from} – ${to}</div>
<script>window.onload = function() { window.print(); }</script>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="statement-${clientData.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html"`);
      return res.status(200).send(html);
    }

    // JSON format (default)
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
