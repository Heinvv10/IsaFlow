/**
 * Credit Notes API
 * GET  /api/accounting/credit-notes - List credit notes (with filters)
 * POST /api/accounting/credit-notes - Create draft credit note
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getCreditNotes,
  getCreditNoteById,
  createCreditNote,
} from '@/modules/accounting/services/creditNoteService';
import type { CreditNoteStatus } from '@/modules/accounting/types/ar.types';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const { id, type, status, limit, offset } = req.query;
      if (id) {
        const note = await getCreditNoteById(companyId, id as string);
        if (!note) return apiResponse.notFound(res, 'Credit Note', id as string);
        return apiResponse.success(res, note);
      }
      const result = await getCreditNotes(companyId, {
        type: type as 'customer' | 'supplier' | undefined,
        status: status as CreditNoteStatus | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get credit notes', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to get credit notes');
    }
  }

  if (req.method === 'POST') {
    try {
      const { type, clientId, customerInvoiceId, supplierId, supplierInvoiceId,
        creditDate, reason, subtotal, taxRate, projectId } = req.body;

      if (!type || !creditDate || subtotal === undefined) {
        return apiResponse.badRequest(res, 'type, creditDate, and subtotal are required');
      }

      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;

      const creditNote = await createCreditNote(companyId, {
        type,
        clientId: clientId || undefined,
        customerInvoiceId: customerInvoiceId || undefined,
        supplierId: supplierId || undefined,
        supplierInvoiceId: supplierInvoiceId || undefined,
        creditDate,
        reason: reason || undefined,
        subtotal: Number(subtotal),
        taxRate: taxRate !== undefined ? Number(taxRate) : undefined,
        projectId: projectId || undefined,
      }, userId);

      return apiResponse.created(res, creditNote);
    } catch (err) {
      log.error('Failed to create credit note', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to create credit note');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
