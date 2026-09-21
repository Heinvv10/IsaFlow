/**
 * Customer Statement API
 * GET /api/accounting/customer-statement
 *   Params:
 *     customerId  — required UUID
 *     fromDate    — YYYY-MM-DD (optional, defaults to 1 year ago); everything
 *                   before it is carried in as a brought-forward balance
 *     toDate      — YYYY-MM-DD (optional, defaults to today)
 *     format      — 'json' (default) | 'pdf'  (streams PDF)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type CompanyAuthedRequest,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
} from '@/lib/auth';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { buildStatementHtml } from '@/modules/accounting/utils/customerStatementHtml';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';
import {
  CREDIT_NOTE_STATEMENT_VALUE, LIVE_CREDIT_NOTE_STATUSES, SETTLING_RECEIPT_STATUSES, applyRunningBalance,
  customerBalanceBroughtForward, openingBalanceLine, resolveStatementWindow, statementClosingBalance,
  type StatementLine,
} from '@/modules/accounting/services/ar/customerStatementRules';

type Row = Record<string, unknown>;

// P3.4: this endpoint has no offset-pagination UI (single full-history view
// with a running balance), and offset paging would silently break the
// running-balance math anyway. Instead cap each source at a generous
// per-entity ceiling — a safety valve, not user-facing paging, on top of the
// existing date-range filter — and source the headline totals from a SQL
// aggregate over the FULL (date-filtered) population so they stay correct
// even if a pathological single customer ever hits the ceiling.
const STATEMENT_ROW_CEILING = 2000;

/** Normalize any date value to YYYY-MM-DD */
function toISODate(val: unknown): string {
  if (!val) return '1970-01-01';
  if (val instanceof Date) return fmtDate(val);
  const s = String(val);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '1970-01-01' : fmtDate(d);
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { customerId, fromDate, toDate, format } = req.query;

  if (!customerId || typeof customerId !== 'string') {
    return apiResponse.badRequest(res, 'customerId is required');
  }

  const statementWindow = resolveStatementWindow(fromDate, toDate);
  if ('error' in statementWindow) return apiResponse.badRequest(res, statementWindow.error);
  const { from, to } = statementWindow;

  try {
    const customerRows = await sql`
      SELECT id, name, email, phone, billing_address AS address
      FROM customers
      WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID
    -- A soft-deleted CUSTOMER has no statement: the record is hidden
      -- everywhere else (customerLedgerService does the same), and drawing one
      -- here would email a balance for a contact the user has removed.
        AND deleted_at IS NULL
    ` as Row[];

    if (customerRows.length === 0) {
      return apiResponse.notFound(res, 'Customer', customerId);
    }
    const customer = customerRows[0]!;

    const invoicesRaw = await sql`
      SELECT ci.id, ci.invoice_number, ci.invoice_date, ci.total_amount, ci.status
      FROM customer_invoices ci
      -- COALESCE, not client_id alone: both columns exist and the emailed
      -- statement (statementEmailService) already reads them that way, so
      -- client_id alone dropped from the screen invoices the email billed.
      WHERE COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
        AND ci.company_id  = ${companyId}::UUID
        -- Hein decided 2026-09-11 (R-082): statements must not show draft
        -- invoices, and must agree with the ageing on a null status. Routed
        -- through the shared rule (R-059 round 6) instead of the bare
        -- != 'cancelled', which kept drafts and dropped null-status rows.
        AND ${sql.unsafe(documentInPopulationExpr('ci'))}
        -- A deleted invoice is not owed and is not in aging — but the delete's
        -- reversal is dated to the DELETE, so this window's upper bound is what
        -- decides it, exactly as in arAgingService. An undated exclusion drops
        -- an invoice the control account still carries at that upper bound.
        AND ${documentInLedgerAsAtFragment('ci', to, companyId)}
        AND ci.invoice_date BETWEEN ${from}::DATE AND ${to}::DATE
      ORDER BY invoice_date, id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    ` as Row[];

    // Receipts at the cash received and live credit notes at the emailed
    // statement's valuation (R-113) — see customerStatementRules.
    const paymentsRaw = await sql`
      SELECT cp.id, cp.payment_number, cp.payment_date, cp.bank_reference, cp.total_amount
      FROM customer_payments cp
      WHERE cp.client_id   = ${customerId}::UUID
        AND cp.company_id  = ${companyId}::UUID
        AND cp.status = ANY(${SETTLING_RECEIPT_STATUSES})
        AND cp.payment_date BETWEEN ${from}::DATE AND ${to}::DATE
      ORDER BY cp.payment_date, cp.id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    ` as Row[];

    const creditNotesRaw = await sql`
      SELECT id, credit_note_number, credit_date, reason,
             ${sql.unsafe(CREDIT_NOTE_STATEMENT_VALUE)} AS total_amount
      FROM credit_notes
      WHERE client_id  = ${customerId}::UUID
        AND company_id = ${companyId}::UUID
        AND type       = 'customer'
        AND status     = ANY(${LIVE_CREDIT_NOTE_STATUSES})
        AND credit_date BETWEEN ${from}::DATE AND ${to}::DATE
      ORDER BY credit_date, id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    ` as Row[];

    const truncated =
      invoicesRaw.length > STATEMENT_ROW_CEILING ||
      paymentsRaw.length > STATEMENT_ROW_CEILING ||
      creditNotesRaw.length > STATEMENT_ROW_CEILING;
    if (truncated) {
      log.warn('Customer statement hit the per-entity row ceiling', {
        customerId, from, to, ceiling: STATEMENT_ROW_CEILING,
      }, 'accounting');
    }
    const invoices = invoicesRaw.slice(0, STATEMENT_ROW_CEILING);
    const payments = paymentsRaw.slice(0, STATEMENT_ROW_CEILING);
    const creditNotes = creditNotesRaw.slice(0, STATEMENT_ROW_CEILING);

    // Headline totals come from a SQL aggregate over the FULL (date-filtered)
    // population, so they stay correct even when the row ceiling above
    // truncates the detail list.
    const [totalsRow] = await sql`
      SELECT
        COALESCE((
          SELECT SUM(ci.total_amount::numeric) FROM customer_invoices ci
          WHERE COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
            AND ci.company_id = ${companyId}::UUID
            AND ${sql.unsafe(documentInPopulationExpr('ci'))}
            AND ${documentInLedgerAsAtFragment('ci', to, companyId)}
            AND ci.invoice_date BETWEEN ${from}::DATE AND ${to}::DATE
        ), 0) AS total_invoiced,
        COALESCE((
          SELECT SUM(cp.total_amount::numeric) FROM customer_payments cp
          WHERE cp.client_id = ${customerId}::UUID AND cp.company_id = ${companyId}::UUID
            AND cp.status = ANY(${SETTLING_RECEIPT_STATUSES})
            AND cp.payment_date BETWEEN ${from}::DATE AND ${to}::DATE
        ), 0) AS total_paid,
        COALESCE((
          SELECT SUM(${sql.unsafe(CREDIT_NOTE_STATEMENT_VALUE)}::numeric) FROM credit_notes
          WHERE client_id = ${customerId}::UUID AND company_id = ${companyId}::UUID
            AND type = 'customer' AND status = ANY(${LIVE_CREDIT_NOTE_STATUSES})
            AND credit_date BETWEEN ${from}::DATE AND ${to}::DATE
        ), 0) AS total_credits
    ` as Row[];

    const transactions: StatementLine[] = [];

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
        debit: 0, credit: Number(pmt.total_amount), balance: 0,
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

    // Everything before the window is carried in, not dropped (R-113): the
    // default one-year window otherwise stated older debt as paid.
    const openingBalance = await customerBalanceBroughtForward(companyId, customerId, from, to);
    const opening = openingBalanceLine(openingBalance, from);
    if (opening) transactions.unshift(opening);
    // Running balance within the (possibly-capped) returned transaction list.
    applyRunningBalance(transactions);

    const totalInvoiced = Number(totalsRow?.total_invoiced ?? 0);
    const totalPaid = Number(totalsRow?.total_paid ?? 0);
    const totalCredits = Number(totalsRow?.total_credits ?? 0);
    const summary = {
      openingBalance, totalInvoiced, totalPaid, totalCredits,
      balance: statementClosingBalance(openingBalance, totalInvoiced, totalPaid, totalCredits),
    };
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
    }, undefined, 200, { truncated });
  } catch (err) {
    log.error('Failed to fetch customer statement', { customerId, error: err }, 'accounting');
    return apiResponse.databaseError(res, err, 'Failed to fetch customer statement');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
