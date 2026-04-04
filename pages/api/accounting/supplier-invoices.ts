/**
 * Supplier Invoices API
 * GET  /api/accounting/supplier-invoices - List invoices (with filters)
 * POST /api/accounting/supplier-invoices - Create draft invoice
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getSupplierInvoices,
  createSupplierInvoice,
} from '@/modules/accounting/services/supplierInvoiceService';
import type { SupplierInvoiceStatus } from '@/modules/accounting/types/ap.types';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const { status, supplier_id, match_status, limit, offset } = req.query;
      const result = await getSupplierInvoices(companyId, {
        status: status as SupplierInvoiceStatus | undefined,
        supplierId: supplier_id ? String(supplier_id) : undefined,
        matchStatus: match_status as 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched' | undefined,
        limit: limit ? Math.min(Number(limit), 200) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get supplier invoices', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get supplier invoices');
    }
  }

  if (req.method === 'POST') {
    try {
      const { invoiceNumber, supplierId, purchaseOrderId, grnId, invoiceDate,
        dueDate, taxRate, paymentTerms, reference, projectId, costCenterId,
        notes, items } = req.body;

      if (!invoiceNumber || !supplierId || !invoiceDate || !items || !Array.isArray(items) || items.length === 0) {
        return apiResponse.badRequest(res, 'invoiceNumber, supplierId, invoiceDate, and items are required');
      }

      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;

      const invoice = await createSupplierInvoice(companyId, {
        invoiceNumber, supplierId: String(supplierId), purchaseOrderId, grnId,
        invoiceDate, dueDate, taxRate: taxRate ? Number(taxRate) : undefined,
        paymentTerms, reference, projectId, costCenterId, notes, items,
      }, userId);

      return apiResponse.created(res, invoice);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create supplier invoice';
      log.error('Failed to create supplier invoice', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
