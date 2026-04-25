/**
 * Supplier Invoices API
 * GET  /api/accounting/supplier-invoices - List invoices (with filters)
 * POST /api/accounting/supplier-invoices - Create draft invoice
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import {
  getSupplierInvoices,
  getSupplierInvoiceStatusCounts,
  createSupplierInvoice,
  type SupplierInvoiceSort,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import type { SupplierInvoiceStatus } from '@/modules/accounting/types/ap.types';

const VALID_SORTS: SupplierInvoiceSort[] = [
  'invoice_number', 'supplier_name', 'reference', 'invoice_date',
  'total_amount', 'balance', 'status',
];

function parseNumeric(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function getHandler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const {
      status, supplier_id, match_status, limit, offset,
      search, from_date, to_date, from_amount, to_amount,
      from_balance, to_balance, sort, sort_order, status_counts,
    } = req.query;

    if (status_counts) {
      const counts = await getSupplierInvoiceStatusCounts(companyId);
      return apiResponse.success(res, { counts });
    }

    const sortKey = typeof sort === 'string' && (VALID_SORTS as string[]).includes(sort)
      ? sort as SupplierInvoiceSort
      : undefined;
    const sortOrder = sort_order === 'asc' ? 'asc' as const
      : sort_order === 'desc' ? 'desc' as const : undefined;

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
      limit: limit ? Math.min(Number(limit), 200) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to get supplier invoices', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to get supplier invoices');
  }
}

async function postHandler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const { invoiceNumber, supplierId, purchaseOrderId, grnId, invoiceDate,
      dueDate, taxRate, paymentTerms, reference, projectId, costCenterId,
      notes, items, currencyCode, exchangeRate } = req.body;

    if (!invoiceNumber || !supplierId || !invoiceDate || !items || !Array.isArray(items) || items.length === 0) {
      return apiResponse.badRequest(res, 'invoiceNumber, supplierId, invoiceDate, and items are required');
    }

    // User identity comes from JWT (req.user), never from client request body
    const userId = req.user.id;

    const invoice = await createSupplierInvoice(companyId, {
      invoiceNumber, supplierId: String(supplierId), purchaseOrderId, grnId,
      invoiceDate, dueDate, taxRate: taxRate ? Number(taxRate) : undefined,
      paymentTerms, reference, projectId, costCenterId, notes, items,
      currencyCode: typeof currencyCode === 'string' ? currencyCode : undefined,
      exchangeRate: exchangeRate ? Number(exchangeRate) : undefined,
    }, userId);

    return apiResponse.created(res, invoice);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create supplier invoice';
    log.error('Failed to create supplier invoice', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

const meteredPost = withFlowMeter('supplier.bill.create', getFlowCost('supplier.bill.create'))(postHandler);

async function mux(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return meteredPost(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(mux))));
