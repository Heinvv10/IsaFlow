/**
 * Supplier Statement Detail API
 * GET /api/accounting/supplier-statement-detail?supplier_id=UUID
 * Returns full transaction history (invoices, payments, returns) with running balance
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

interface Transaction {
  id: number;
  date: string;
  type: 'invoice' | 'payment' | 'debit_note';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export default withCompany(withErrorHandler(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const { supplier_id } = req.query;
  if (!supplier_id) return apiResponse.badRequest(res, 'supplier_id is required');

  try {
    // Get supplier info
    const supplierRows = await sql`
      SELECT id, name, email, phone FROM suppliers WHERE id = ${Number(supplier_id)} AND company_id = ${companyId}
    `;
    if (supplierRows.length === 0) return apiResponse.notFound(res, 'Supplier', supplier_id as string);
    const supplier = supplierRows[0] as { id: number; name: string; email: string | null; phone: string | null };

    // Get invoices
    const invoices = await sql`
      SELECT id, invoice_number as reference, invoice_date as date,
        total_amount as amount, amount_paid, notes as description
      FROM supplier_invoices
      WHERE supplier_id = ${Number(supplier_id)} AND company_id = ${companyId}
        AND status NOT IN ('cancelled', 'draft')
      ORDER BY invoice_date ASC
    `;

    // Get payments
    const payments = await sql`
      SELECT sp.id, sp.payment_number as reference, sp.payment_date as date,
        sp.total_amount as amount, sp.description
      FROM supplier_payments sp
      WHERE sp.supplier_id = ${Number(supplier_id)} AND sp.company_id = ${companyId}
        AND sp.status NOT IN ('cancelled', 'draft')
      ORDER BY sp.payment_date ASC
    `;

    // Get debit notes (supplier returns)
    const returns = await sql`
      SELECT cn.id, cn.credit_note_number as reference, cn.credit_date as date,
        cn.total_amount as amount, cn.reason as description
      FROM credit_notes cn
      WHERE cn.supplier_id = ${Number(supplier_id)} AND cn.company_id = ${companyId}
        AND cn.type = 'supplier'
        AND cn.status NOT IN ('cancelled', 'draft')
      ORDER BY cn.credit_date ASC
    `;

    // Normalize date to YYYY-MM-DD regardless of input format
    const toISODate = (val: unknown): string => {
      if (!val) return '1970-01-01';
      if (val instanceof Date) return val.toISOString().split('T')[0] ?? '1970-01-01';
      const s = String(val);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0] ?? '1970-01-01';
      const d = new Date(s);
      return isNaN(d.getTime()) ? '1970-01-01' : (d.toISOString().split('T')[0] ?? '1970-01-01');
    };

    // Merge into chronological transactions
    const transactions: Transaction[] = [];

    for (const inv of invoices as { id: number; reference: string; date: string; amount: number; description: string }[]) {
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

    for (const pmt of payments as { id: number; reference: string; date: string; amount: number; description: string }[]) {
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

    for (const ret of returns as { id: number; reference: string; date: string; amount: number; description: string }[]) {
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

    // Calculate running balance
    let running = 0;
    for (const txn of transactions) {
      running += txn.debit - txn.credit;
      txn.balance = running;
    }

    const totalInvoiced = transactions.reduce((s, t) => s + t.debit, 0);
    const totalPaid = transactions.filter(t => t.type === 'payment').reduce((s, t) => s + t.credit, 0);
    const totalReturns = transactions.filter(t => t.type === 'debit_note').reduce((s, t) => s + t.credit, 0);

    return apiResponse.success(res, {
      supplier,
      transactions,
      summary: {
        totalInvoiced,
        totalPaid,
        totalReturns,
        balance: totalInvoiced - totalPaid - totalReturns,
      },
    });
  } catch (err) {
    log.error('Supplier statement detail failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to load supplier statement');
  }
}));
