/**
 * Supplier Invoice Detail API
 * GET /api/accounting/supplier-invoices-detail?id=UUID - Get invoice with items
 * PUT - Update draft invoice fields
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getSupplierInvoiceById } from '@/modules/accounting/services/supplierInvoiceService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const id = req.query.id as string;
      if (!id) return apiResponse.badRequest(res, 'id query parameter is required');
      const invoice = await getSupplierInvoiceById(companyId, id);
      if (!invoice) return apiResponse.notFound(res, 'Supplier invoice', id);
      return apiResponse.success(res, invoice);
    } catch (err) {
      log.error('Failed to get supplier invoice detail', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get supplier invoice');
    }
  }

  if (req.method === 'PUT') {
    const { id, invoiceNumber, invoiceDate, dueDate, paymentTerms, notes } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      await sql`
        UPDATE supplier_invoices
        SET invoice_number = COALESCE(${invoiceNumber || null}, invoice_number),
            invoice_date = COALESCE(${invoiceDate || null}, invoice_date),
            due_date = COALESCE(${dueDate || null}, due_date),
            payment_terms = COALESCE(${paymentTerms || null}, payment_terms),
            notes = COALESCE(${notes || null}, notes),
            updated_at = NOW()
        WHERE id = ${id}::UUID AND company_id = ${companyId} AND status IN ('draft', 'pending_approval')
      `;
      log.info('Supplier invoice updated', { id });
      const updated = await getSupplierInvoiceById(companyId, id);
      return apiResponse.success(res, updated);
    } catch (err) {
      log.error('Failed to update supplier invoice', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to update');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
