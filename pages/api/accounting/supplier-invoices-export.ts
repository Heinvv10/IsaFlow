/**
 * Supplier Invoices Export API
 * GET /api/accounting/supplier-invoices-export — export filtered list as CSV
 *
 * Honours the same filter/sort params as supplier-invoices.ts so the CSV
 * matches what the user sees in the list (no pagination cap).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { csvCell } from '@/lib/csv';
import {
  getSupplierInvoices,
  type SupplierInvoiceSort,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import type { SupplierInvoiceStatus } from '@/modules/accounting/types/ap.types';
import { formatDate } from '@/utils/formatters';

const VALID_SORTS: SupplierInvoiceSort[] = [
  'invoice_number', 'supplier_name', 'reference', 'invoice_date',
  'total_amount', 'balance', 'status',
];

function parseNumeric(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  try {
    const {
      status, supplier_id, match_status, search,
      from_date, to_date, from_amount, to_amount,
      from_balance, to_balance, sort, sort_order,
    } = req.query;

    const sortKey = typeof sort === 'string' && (VALID_SORTS as string[]).includes(sort)
      ? sort as SupplierInvoiceSort
      : undefined;
    const sortOrder = sort_order === 'asc' ? 'asc' as const
      : sort_order === 'desc' ? 'desc' as const : undefined;

    // Pull the full filtered set in pages of 200 (the service hard-caps the limit).
    const allInvoices: Awaited<ReturnType<typeof getSupplierInvoices>>['invoices'] = [];
    const PAGE_SIZE = 200;
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const result = await getSupplierInvoices(companyId, {
        status: status as SupplierInvoiceStatus | undefined,
        supplierId: supplier_id ? String(supplier_id) : undefined,
        matchStatus: match_status as 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched' | undefined,
        search: typeof search === 'string' ? search : undefined,
        fromDate: typeof from_date === 'string' ? from_date : undefined,
        toDate: typeof to_date === 'string' ? to_date : undefined,
        fromAmount: parseNumeric(from_amount),
        toAmount: parseNumeric(to_amount),
        fromBalance: parseNumeric(from_balance),
        toBalance: parseNumeric(to_balance),
        sort: sortKey,
        sortOrder,
        limit: PAGE_SIZE,
        offset,
      });
      allInvoices.push(...result.invoices);
      total = result.total;
      offset += PAGE_SIZE;
      if (result.invoices.length < PAGE_SIZE) break;
    }

    const lines = [
      'Invoice #,Supplier,Reference,Invoice Date,Due Date,Subtotal,Tax,Total,Paid,Outstanding,Status',
      ...allInvoices.map((inv) => [
        csvCell(inv.invoiceNumber),
        csvCell(inv.supplierName ?? ''),
        csvCell(inv.reference ?? ''),
        csvCell(formatDate(inv.invoiceDate)),
        csvCell(inv.dueDate ? formatDate(inv.dueDate) : ''),
        Number(inv.subtotal).toFixed(2),
        Number(inv.taxAmount).toFixed(2),
        Number(inv.totalAmount).toFixed(2),
        Number(inv.amountPaid).toFixed(2),
        Number(inv.balance ?? (inv.totalAmount - inv.amountPaid)).toFixed(2),
        csvCell(inv.status),
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="supplier-invoices-${new Date().toISOString().split('T')[0]}.csv"`,
    );
    return res.status(200).send(lines.join('\n'));
  } catch (err) {
    log.error('Supplier invoices export failed', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to export supplier invoices');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
