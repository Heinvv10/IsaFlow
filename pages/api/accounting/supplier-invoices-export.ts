/**
 * Supplier Invoices Export API
 * GET /api/accounting/supplier-invoices-export — export filtered list as CSV
 *
 * Honours the same filter/sort params as supplier-invoices.ts so the CSV
 * matches what the user sees. Single un-paginated DB query (capped at
 * SUPPLIER_INVOICE_EXPORT_CAP for safety) — MVCC snapshot consistency, no
 * risk of skipped/duplicated rows from concurrent inserts.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { csvCell } from '@/lib/csv';
import {
  getSupplierInvoicesForExport,
  SUPPLIER_INVOICE_EXPORT_CAP,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { parseSupplierInvoiceFilters } from '@/modules/accounting/services/ap/supplierInvoiceFilterParams';
import { formatDate } from '@/utils/formatters';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  try {
    const parsed = parseSupplierInvoiceFilters(req.query);
    if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);

    const { invoices, truncated } = await getSupplierInvoicesForExport(companyId, parsed.filters);

    if (truncated) {
      log.warn('Supplier invoice export hit row cap', {
        companyId, cap: SUPPLIER_INVOICE_EXPORT_CAP, rows: invoices.length,
      }, 'accounting-api');
    }

    const lines = [
      'Invoice #,Supplier,Reference,Invoice Date,Due Date,Subtotal,Tax,Total,Paid,Outstanding,Status',
      ...invoices.map((inv) => [
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
    if (truncated) {
      res.setHeader('X-Export-Truncated', String(SUPPLIER_INVOICE_EXPORT_CAP));
    }
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
