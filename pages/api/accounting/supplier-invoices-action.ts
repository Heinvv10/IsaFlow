/**
 * Supplier Invoice Actions API
 * POST /api/accounting/supplier-invoices-action
 *   action: approve | cancel | match
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  approveSupplierInvoice,
  cancelSupplierInvoice,
  performThreeWayMatch,
} from '@/modules/accounting/services/ap/supplierInvoiceService';

const SupplierInvoiceActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), invoiceId: UUID }),
  z.object({ action: z.literal('cancel'), invoiceId: UUID }),
  z.object({ action: z.literal('match'), invoiceId: UUID }),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const parsed = SupplierInvoiceActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  try {
    const { action, invoiceId } = parsed.data;
    const userId = req.user.id;

    switch (action) {
      case 'approve': {
        const invoice = await approveSupplierInvoice(companyId, invoiceId, userId);
        return apiResponse.success(res, invoice);
      }
      case 'cancel': {
        const invoice = await cancelSupplierInvoice(companyId, invoiceId);
        return apiResponse.success(res, invoice);
      }
      case 'match': {
        const result = await performThreeWayMatch(companyId, invoiceId);
        return apiResponse.success(res, result);
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Supplier invoice action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))));
