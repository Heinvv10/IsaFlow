/**
 * Supplier Statement Detail API
 * GET /api/accounting/supplier-statement-detail?supplier_id=UUID
 * Returns full transaction history (invoices, payments, returns) with running balance
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import { isUuidParam, isRealCalendarDate } from '@/lib/validation';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';

interface Transaction {
  id: string;
  date: string;
  type: 'invoice' | 'payment' | 'debit_note';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

// P3.4: this endpoint has no offset-pagination UI (single full-history view
// with a running balance), and offset paging would silently break the
// running-balance math anyway. Instead cap each source at a generous
// per-entity ceiling — a safety valve, not user-facing paging — and source
// the headline totals from a SQL aggregate over the FULL population so they
// stay correct even if a pathological single supplier ever hits the ceiling.
const STATEMENT_ROW_CEILING = 2000;

export default withAuth(withErrorHandler(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const { supplier_id } = req.query;
  if (!isUuidParam(supplier_id)) return apiResponse.badRequest(res, 'supplier_id must be a valid UUID');

  const asAtDate = req.query.as_at_date ?? fmtDate(new Date());
  if (typeof asAtDate !== 'string' || !isRealCalendarDate(asAtDate)) {
    return apiResponse.badRequest(res, 'as_at_date must be a valid calendar date');
  }

  try {
    // Get supplier info
    const supplierRows = await sql`
      SELECT id, name, email, phone FROM suppliers WHERE id = ${supplier_id} AND company_id = ${companyId}
    `;
    if (supplierRows.length === 0) return apiResponse.notFound(res, 'Supplier', supplier_id as string);
    const supplier = supplierRows[0] as { id: string; name: string; email: string | null; phone: string | null };

    // Get invoices
    const invoicesRaw = await sql`
      SELECT id, invoice_number as reference, invoice_date as date,
        total_amount as amount, amount_paid, notes as description
      FROM supplier_invoices si
      WHERE si.supplier_id = ${supplier_id} AND si.company_id = ${companyId}
        -- The ageing's status rule, shared rather than re-typed, so this page
        -- and the ageing admit the same BILLS. The page's balance is not the
        -- ageing's total: it subtracts EVERY processed payment (total_paid
        -- below), allocated or not, where the ageing nets only what is
        -- allocated to a bill. So it ties to the payable CONTROL — the ageing
        -- less unapplied, on-account payments — and K-053 pins it there.
        -- The bare spelling dropped a null-status bill while still deducting its
        -- payment: balance -400 against a control of 750 (R-059 round 7).
        AND ${sql.unsafe(documentInPopulationExpr('si'))}
        -- A soft-deleted bill leaves this statement exactly when the delete's
        -- GL reversal reaches the ledger, and not one day earlier — the same
        -- dated question the ageing and the control account ask.
        AND ${documentInLedgerAsAtFragment('si', asAtDate, companyId)}
        AND si.invoice_date <= ${asAtDate}::DATE
      ORDER BY si.invoice_date ASC, si.id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    `;

    // Get payments
    const paymentsRaw = await sql`
      SELECT sp.id, sp.payment_number as reference, sp.payment_date as date,
        sp.total_amount as amount, sp.description
      FROM supplier_payments sp
      WHERE sp.supplier_id = ${supplier_id} AND sp.company_id = ${companyId}
        AND sp.status NOT IN ('cancelled', 'draft')
        AND sp.payment_date <= ${asAtDate}::DATE
      ORDER BY sp.payment_date ASC, sp.id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    `;

    // Get debit notes (supplier returns)
    const returnsRaw = await sql`
      SELECT cn.id, cn.credit_note_number as reference, cn.credit_date as date,
        cn.total_amount as amount, cn.reason as description
      FROM credit_notes cn
      WHERE cn.supplier_id = ${supplier_id} AND cn.company_id = ${companyId}
        AND cn.type = 'supplier'
        AND cn.status NOT IN ('cancelled', 'draft')
        AND cn.credit_date <= ${asAtDate}::DATE
      ORDER BY cn.credit_date ASC, cn.id
      LIMIT ${STATEMENT_ROW_CEILING + 1}
    `;

    const truncated =
      invoicesRaw.length > STATEMENT_ROW_CEILING ||
      paymentsRaw.length > STATEMENT_ROW_CEILING ||
      returnsRaw.length > STATEMENT_ROW_CEILING;
    if (truncated) {
      log.warn('Supplier statement detail hit the per-entity row ceiling', {
        supplier_id, ceiling: STATEMENT_ROW_CEILING,
      }, 'accounting-api');
    }
    const invoices = invoicesRaw.slice(0, STATEMENT_ROW_CEILING);
    const payments = paymentsRaw.slice(0, STATEMENT_ROW_CEILING);
    const returns = returnsRaw.slice(0, STATEMENT_ROW_CEILING);

    // Headline totals come from a SQL aggregate over the FULL population, so
    // they stay correct even when the row ceiling above truncates the detail list.
    const [totalsRow] = await sql`
      SELECT
        COALESCE((
          SELECT SUM(si.total_amount::numeric) FROM supplier_invoices si
          WHERE si.supplier_id = ${supplier_id} AND si.company_id = ${companyId}
            AND ${sql.unsafe(documentInPopulationExpr('si'))}
            AND ${documentInLedgerAsAtFragment('si', asAtDate, companyId)}
            AND si.invoice_date <= ${asAtDate}::DATE
        ), 0) AS total_invoiced,
        COALESCE((
          SELECT SUM(total_amount::numeric) FROM supplier_payments
          WHERE supplier_id = ${supplier_id} AND company_id = ${companyId} AND status NOT IN ('cancelled', 'draft')
            AND payment_date <= ${asAtDate}::DATE
        ), 0) AS total_paid,
        COALESCE((
          SELECT SUM(total_amount::numeric) FROM credit_notes
          WHERE supplier_id = ${supplier_id} AND company_id = ${companyId} AND type = 'supplier' AND status NOT IN ('cancelled', 'draft')
            AND credit_date <= ${asAtDate}::DATE
        ), 0) AS total_returns
    ` as { total_invoiced: number; total_paid: number; total_returns: number }[];

    // Normalize date to YYYY-MM-DD regardless of input format
    const toISODate = (val: unknown): string => {
      if (!val) return '1970-01-01';
      if (val instanceof Date) return fmtDate(val);
      const s = String(val);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
      const d = new Date(s);
      return isNaN(d.getTime()) ? '1970-01-01' : fmtDate(d);
    };

    // Merge into chronological transactions
    const transactions: Transaction[] = [];

    for (const inv of invoices as { id: string; reference: string; date: string; amount: number; description: string }[]) {
      transactions.push({
        id: inv.id,
        date: toISODate(inv.date),
        type: 'invoice',
        reference: inv.reference || '-',
        description: inv.description || 'Supplier Invoice',
        debit: Number(inv.amount),
        credit: 0,
        balance: 0,
      });
    }

    for (const pmt of payments as { id: string; reference: string; date: string; amount: number; description: string }[]) {
      transactions.push({
        id: pmt.id,
        date: toISODate(pmt.date),
        type: 'payment',
        reference: pmt.reference || '-',
        description: pmt.description || 'Payment',
        debit: 0,
        credit: Number(pmt.amount),
        balance: 0,
      });
    }

    for (const ret of returns as { id: string; reference: string; date: string; amount: number; description: string }[]) {
      transactions.push({
        id: ret.id,
        date: toISODate(ret.date),
        type: 'debit_note',
        reference: ret.reference || '-',
        description: ret.description || 'Debit Note',
        debit: 0,
        credit: Number(ret.amount),
        balance: 0,
      });
    }

    // Sort chronologically, invoices before payments on same date
    transactions.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const typeOrder: Record<string, number> = { invoice: 0, debit_note: 1, payment: 2 };
      return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
    });

    // Running balance within the (possibly-capped) returned transaction list.
    let running = 0;
    for (const txn of transactions) {
      running += txn.debit - txn.credit;
      txn.balance = running;
    }

    const totalInvoiced = Number(totalsRow?.total_invoiced ?? 0);
    const totalPaid = Number(totalsRow?.total_paid ?? 0);
    const totalReturns = Number(totalsRow?.total_returns ?? 0);

    return apiResponse.success(res, {
      supplier,
      asAtDate,
      transactions,
      summary: {
        totalInvoiced,
        totalPaid,
        totalReturns,
        balance: totalInvoiced - totalPaid - totalReturns,
      },
    }, undefined, 200, { truncated });
  } catch (err) {
    log.error('Supplier statement detail failed', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to load supplier statement');
  }
}));
