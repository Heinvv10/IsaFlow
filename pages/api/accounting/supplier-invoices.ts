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
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { parseSupplierInvoiceFilters } from '@/modules/accounting/services/ap/supplierInvoiceFilterParams';

async function getHandler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  try {
    if (req.query.status_counts) {
      const counts = await getSupplierInvoiceStatusCounts(companyId);
      return apiResponse.success(res, { counts });
    }

    const parsed = parseSupplierInvoiceFilters(req.query);
    if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);

    const result = await getSupplierInvoices(companyId, parsed.filters);
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
