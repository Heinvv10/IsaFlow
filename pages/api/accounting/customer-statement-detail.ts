import { sql } from '@/lib/neon';
/**
 * Customer Statement Detail API
 * GET /api/accounting/customer-statement-detail?client_id=UUID
 * Returns full transaction-level statement with running balance
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
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

  try {
    // Get client info
    const clientRows = (await sql`
      SELECT id, name, email, phone FROM customers WHERE id = ${clientId}::UUID AND company_id = ${companyId}
    `) as Row[];
    if (clientRows.length === 0) {
      return apiResponse.notFound(res, 'Client', clientId);
    }
    const client = clientRows[0]!;

    // Get invoices
    const invoicesRaw = (await sql`
      SELECT id, invoice_number, invoice_date, notes, total_amount, status
      FROM customer_invoices
      WHERE COALESCE(client_id, customer_id) = ${clientId}::UUID AND company_id = ${companyId} AND status != 'cancelled'
      ORDER BY invoice_date, id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    `) as Row[];

    // Get confirmed payments — includes both allocated and unallocated (bank-sourced)
    const paymentsRaw = (await sql`
      SELECT cp.id, cp.payment_number, cp.payment_date, cp.bank_reference,
        COALESCE(SUM(cpa.amount_allocated), cp.total_amount) AS amount_allocated
      FROM customer_payments cp
      LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
      WHERE cp.client_id = ${clientId}::UUID AND cp.company_id = ${companyId} AND cp.status IN ('confirmed', 'reconciled')
      GROUP BY cp.id, cp.payment_number, cp.payment_date, cp.bank_reference, cp.total_amount
      ORDER BY cp.payment_date, cp.id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    `) as Row[];

    // Get approved customer credit notes
    const creditNotesRaw = (await sql`
      SELECT id, credit_note_number, credit_date, reason, total_amount
      FROM credit_notes
      WHERE client_id = ${clientId}::UUID AND company_id = ${companyId} AND type = 'customer' AND status = 'approved'
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
          SELECT SUM(total_amount::numeric) FROM customer_invoices
          WHERE COALESCE(client_id, customer_id) = ${clientId}::UUID AND company_id = ${companyId} AND status != 'cancelled'
        ), 0) AS total_invoiced,
        COALESCE((
          SELECT SUM(pmt_total) FROM (
            SELECT COALESCE(SUM(cpa.amount_allocated), cp.total_amount) AS pmt_total
            FROM customer_payments cp
            LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
            WHERE cp.client_id = ${clientId}::UUID AND cp.company_id = ${companyId} AND cp.status IN ('confirmed', 'reconciled')
            GROUP BY cp.id, cp.total_amount
          ) pmt
        ), 0) AS total_paid,
        COALESCE((
          SELECT SUM(total_amount::numeric) FROM credit_notes
          WHERE client_id = ${clientId}::UUID AND company_id = ${companyId} AND type = 'customer' AND status = 'approved'
        ), 0) AS total_credits
    `) as Row[];

    // Normalize date to YYYY-MM-DD regardless of input format
    const toISODate = (val: unknown): string => {
      if (!val) return '1970-01-01';
      if (val instanceof Date) return val.toISOString().split('T')[0] ?? '1970-01-01';
      const s = String(val);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
      const d = new Date(s);
      return isNaN(d.getTime()) ? '1970-01-01' : (d.toISOString().split('T')[0] ?? '1970-01-01');
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
        credit: Number(pmt.amount_allocated),
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
    let runningBalance = 0;
    for (const txn of transactions) {
      runningBalance += txn.debit - txn.credit;
      txn.balance = runningBalance;
    }

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
        balance: totalInvoiced - totalPaid - totalCredits,
      },
    }, undefined, 200, { truncated });
  } catch (err) {
    log.error('Failed to fetch customer statement detail', { clientId, error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer statement');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
