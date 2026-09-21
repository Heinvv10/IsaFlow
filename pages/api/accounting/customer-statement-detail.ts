import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
/**
 * Customer Statement Detail API
 * GET /api/accounting/customer-statement-detail?client_id=UUID[&as_at_date=YYYY-MM-DD]
 * Returns full transaction-level statement with running balance
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';
import {
  CREDIT_NOTE_STATEMENT_VALUE, LIVE_CREDIT_NOTE_STATUSES, SETTLING_RECEIPT_STATUSES, applyRunningBalance,
  resolveStatementAsAt, statementClosingBalance,
} from '@/modules/accounting/services/ar/customerStatementRules';
type Row = Record<string, unknown>;

// P3.4: this endpoint has no offset-pagination UI (single full-history view
// with a running balance), and offset paging would silently break the
// running-balance math anyway. Instead cap each source at a generous
// per-entity ceiling — a safety valve, not user-facing paging — and source
// the headline totals from a SQL aggregate over the FULL population so they
// stay correct even if a pathological single client ever hits the ceiling.
const STATEMENT_ROW_CEILING = 2000;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const clientId = req.query.client_id as string;
  if (!clientId) {
    return apiResponse.badRequest(res, 'client_id is required');
  }
  // The full history as at `as_at_date` (R-116: the batch PDFs print that
  // date), or as at today when none is sent. It bounds every document date (a
  // post-dated invoice or receipt is not on the emailed statement either) and
  // is the date its soft-delete question is asked at.
  const asAt = resolveStatementAsAt(req.query.as_at_date);
  if ('error' in asAt) return apiResponse.badRequest(res, asAt.error);
  const asAtStr = asAt.asAt;

  try {
    // Get client info
    const clientRows = (await sql`
      SELECT id, name, email, phone FROM customers WHERE id = ${clientId}::UUID AND company_id = ${companyId}
        -- No statement for a soft-deleted customer, as fetchStatementData.
        AND deleted_at IS NULL
    `) as Row[];
    if (clientRows.length === 0) {
      return apiResponse.notFound(res, 'Client', clientId);
    }
    const client = clientRows[0]!;

    // Get invoices
    const invoicesRaw = (await sql`
      SELECT id, invoice_number, invoice_date, notes, total_amount, status
      FROM customer_invoices ci
      WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID AND ci.company_id = ${companyId}
        -- Hein decided 2026-09-11 (R-082): statements must not show draft
        -- invoices, and must agree with the ageing on a null status. Routed
        -- through the shared rule (R-059 round 6) instead of the bare
        -- != 'cancelled', which kept drafts and dropped null-status rows.
        AND ${sql.unsafe(documentInPopulationExpr('ci'))}
      -- As at the as-at date, not undated: a document soft-deleted BEFORE the delete
      -- began reversing its journal has a standing entry the control account
      -- still carries, and a bare deleted_at IS NULL would drop it from this
      -- figure while the GL keeps it. See shared/softDeleteLedgerPresence.
        AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
        AND ci.invoice_date <= ${asAtStr}::DATE
      ORDER BY ci.invoice_date, ci.id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    `) as Row[];

    // Settled receipts at the cash received (R-112). COALESCE(SUM(allocated),
    // total) fell back to the total only when nothing was allocated, so a
    // partly allocated receipt lost its remainder — see customerStatementRules.
    const paymentsRaw = (await sql`
      SELECT cp.id, cp.payment_number, cp.payment_date, cp.bank_reference, cp.total_amount
      FROM customer_payments cp
      WHERE cp.client_id = ${clientId}::UUID AND cp.company_id = ${companyId}
        AND cp.status = ANY(${SETTLING_RECEIPT_STATUSES})
        AND cp.payment_date <= ${asAtStr}::DATE
      ORDER BY cp.payment_date, cp.id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    `) as Row[];

    // Every LIVE credit note, valued the way the emailed statement values it.
    //
    // `status = 'approved'` alone was two omissions in one. It dropped every
    // note that had been set against an invoice ('applied') — the same defect
    // that once hid applied notes from every statement ever sent — and, since
    // migration 677, every partly placed note ('partially_applied') too. This
    // screen and `ar/statementEmailService` are the same document, so a note
    // visible in one and absent from the other is a customer-facing
    // contradiction.
    //
    // CREDIT_NOTE_STATEMENT_VALUE is the SQL twin of `shared/creditNoteAppliedAmount`: an 'applied'
    // note credits what it CONSUMED, because its remainder is stranded and
    // cannot be applied again; anything else credits its face value, because
    // that credit is still the customer's to use. Keep the two in step.
    const creditNotesRaw = (await sql`
      SELECT id, credit_note_number, credit_date, reason,
             ${sql.unsafe(CREDIT_NOTE_STATEMENT_VALUE)} AS total_amount
      FROM credit_notes
      WHERE client_id = ${clientId}::UUID AND company_id = ${companyId} AND type = 'customer'
        AND status = ANY(${LIVE_CREDIT_NOTE_STATUSES})
        AND credit_date <= ${asAtStr}::DATE
      ORDER BY credit_date, id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    `) as Row[];

    const truncated =
      invoicesRaw.length > STATEMENT_ROW_CEILING ||
      paymentsRaw.length > STATEMENT_ROW_CEILING ||
      creditNotesRaw.length > STATEMENT_ROW_CEILING;
    if (truncated) {
      log.warn('Customer statement detail hit the per-entity row ceiling', {
        clientId, ceiling: STATEMENT_ROW_CEILING,
      }, 'accounting');
    }
    const invoices = invoicesRaw.slice(0, STATEMENT_ROW_CEILING);
    const payments = paymentsRaw.slice(0, STATEMENT_ROW_CEILING);
    const creditNotes = creditNotesRaw.slice(0, STATEMENT_ROW_CEILING);

    // Headline totals come from a SQL aggregate over the FULL population, so
    // they stay correct even when the row ceiling above truncates the detail list.
    const [totalsRow] = (await sql`
      SELECT
        COALESCE((
          SELECT SUM(ci.total_amount::numeric) FROM customer_invoices ci
          WHERE COALESCE(ci.client_id, ci.customer_id) = ${clientId}::UUID AND ci.company_id = ${companyId}
            AND ${sql.unsafe(documentInPopulationExpr('ci'))}
            AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
            AND ci.invoice_date <= ${asAtStr}::DATE
        ), 0) AS total_invoiced,
        COALESCE((
          SELECT SUM(cp.total_amount::numeric) FROM customer_payments cp
          WHERE cp.client_id = ${clientId}::UUID AND cp.company_id = ${companyId}
            AND cp.status = ANY(${SETTLING_RECEIPT_STATUSES})
            AND cp.payment_date <= ${asAtStr}::DATE
        ), 0) AS total_paid,
        COALESCE((
          -- Same population and same valuation as the row list above; a total
          -- the rows do not foot to is worse than no total.
          SELECT SUM(${sql.unsafe(CREDIT_NOTE_STATEMENT_VALUE)}::numeric)
          FROM credit_notes
          WHERE client_id = ${clientId}::UUID AND company_id = ${companyId} AND type = 'customer'
            AND status = ANY(${LIVE_CREDIT_NOTE_STATUSES})
            AND credit_date <= ${asAtStr}::DATE
        ), 0) AS total_credits
    `) as Row[];

    // Normalize date to YYYY-MM-DD regardless of input format
    const toISODate = (val: unknown): string => {
      if (!val) return '1970-01-01';
      if (val instanceof Date) return fmtDate(val);
      const s = String(val);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
      const d = new Date(s);
      return isNaN(d.getTime()) ? '1970-01-01' : fmtDate(d);
    };

    // Build transaction list
    interface Transaction {
      id: number | string;
      date: string;
      type: 'invoice' | 'payment' | 'credit_note';
      reference: string;
      description: string;
      debit: number;
      credit: number;
      balance: number;
    }

    const transactions: Transaction[] = [];

    for (const inv of invoices) {
      transactions.push({
        id: inv.id as string,
        date: toISODate(inv.invoice_date),
        type: 'invoice',
        reference: String(inv.invoice_number),
        description: inv.notes ? String(inv.notes) : '',
        debit: Number(inv.total_amount),
        credit: 0,
        balance: 0,
      });
    }

    for (const pmt of payments) {
      transactions.push({
        id: pmt.id as string,
        date: toISODate(pmt.payment_date),
        type: 'payment',
        reference: String(pmt.payment_number),
        description: pmt.bank_reference ? String(pmt.bank_reference) : '',
        debit: 0,
        credit: Number(pmt.total_amount),
        balance: 0,
      });
    }

    for (const cn of creditNotes) {
      transactions.push({
        id: cn.id as string,
        date: toISODate(cn.credit_date),
        type: 'credit_note',
        reference: String(cn.credit_note_number),
        description: cn.reason ? String(cn.reason) : '',
        debit: 0,
        credit: Number(cn.total_amount),
        balance: 0,
      });
    }

    // Sort chronologically, invoices before payments on same date
    transactions.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const typeOrder: Record<string, number> = { invoice: 0, credit_note: 1, payment: 2 };
      return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
    });

    // Running balance within the (possibly-capped) returned transaction list.
    applyRunningBalance(transactions);

    const totalInvoiced = Number(totalsRow?.total_invoiced ?? 0);
    const totalPaid = Number(totalsRow?.total_paid ?? 0);
    const totalCredits = Number(totalsRow?.total_credits ?? 0);

    return apiResponse.success(res, {
      client: {
        id: String(client.id),
        name: String(client.name),
        email: client.email ? String(client.email) : null,
        phone: client.phone ? String(client.phone) : null,
      },
      transactions,
      summary: {
        totalInvoiced,
        totalPaid,
        totalCredits,
        balance: statementClosingBalance(0, totalInvoiced, totalPaid, totalCredits),
      },
    }, undefined, 200, { truncated });
  } catch (err) {
    log.error('Failed to fetch customer statement detail', { clientId, error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer statement');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
