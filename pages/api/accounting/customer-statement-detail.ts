import { sql } from '@/lib/neon';
/**
 * Customer Statement Detail API
 * GET /api/accounting/customer-statement-detail?client_id=UUID
 * Returns full transaction-level statement with running balance
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';


// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const clientId = req.query.client_id as string;
  if (!clientId) {
    return apiResponse.badRequest(res, 'client_id is required');
  }

  try {
    // Get client info
    const clientRows = (await sql`
      SELECT id, company_name, email, phone FROM clients WHERE id = ${clientId}::UUID
    `) as Row[];
    if (clientRows.length === 0) {
      return apiResponse.notFound(res, 'Client', clientId);
    }
    const client = clientRows[0];

    // Get invoices
    const invoices = (await sql`
      SELECT id, invoice_number, invoice_date, reference, total_amount, status
      FROM customer_invoices
      WHERE client_id = ${clientId}::UUID AND status != 'cancelled'
      ORDER BY invoice_date
    `) as Row[];

    // Get confirmed payments — includes both allocated and unallocated (bank-sourced)
    const payments = (await sql`
      SELECT cp.id, cp.payment_number, cp.payment_date, cp.bank_reference,
        COALESCE(SUM(cpa.amount_allocated), cp.total_amount) AS amount_allocated
      FROM customer_payments cp
      LEFT JOIN customer_payment_allocations cpa ON cpa.payment_id = cp.id
      WHERE cp.client_id = ${clientId}::UUID AND cp.status IN ('confirmed', 'reconciled')
      GROUP BY cp.id, cp.payment_number, cp.payment_date, cp.bank_reference, cp.total_amount
    `) as Row[];

    // Get approved customer credit notes
    const creditNotes = (await sql`
      SELECT id, credit_note_number, credit_date, reason, total_amount
      FROM credit_notes
      WHERE client_id = ${clientId}::UUID AND type = 'customer' AND status = 'approved'
    `) as Row[];

    // Normalize date to YYYY-MM-DD regardless of input format
    function toISODate(val: unknown): string {
      if (!val) return '1970-01-01';
      if (val instanceof Date) return val.toISOString().split('T')[0] ?? '1970-01-01';
      const s = String(val);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
      const d = new Date(s);
      return isNaN(d.getTime()) ? '1970-01-01' : (d.toISOString().split('T')[0] ?? '1970-01-01');
    }

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
        id: inv.id,
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
        id: pmt.id,
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
        id: cn.id,
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

    // Calculate running balance
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

    return apiResponse.success(res, {
      client: {
        id: String(client.id),
        name: String(client.company_name),
        email: client.email ? String(client.email) : null,
        phone: client.phone ? String(client.phone) : null,
      },
      transactions,
      summary: {
        totalInvoiced,
        totalPaid,
        totalCredits,
        balance: runningBalance,
      },
    });
  } catch (err) {
    log.error('Failed to fetch customer statement detail', { clientId, error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer statement');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
