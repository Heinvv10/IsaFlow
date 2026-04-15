/**
 * Credit Note Actions API
 * POST /api/accounting/credit-notes-action
 *   action: approve | cancel | apply
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { approveCreditNote, cancelCreditNote, applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteService';

const CreditNoteActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), creditNoteId: UUID }),
  z.object({ action: z.literal('cancel'), creditNoteId: UUID, reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('apply'), creditNoteId: UUID, invoiceId: UUID }),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const parsed = CreditNoteActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  try {
    const userId = req.user.id;

    switch (parsed.data.action) {
      case 'approve': {
        const creditNote = await approveCreditNote(companyId, parsed.data.creditNoteId, userId);
        return apiResponse.success(res, creditNote);
      }
      case 'cancel': {
        const cancelled = await cancelCreditNote(companyId, parsed.data.creditNoteId, userId, parsed.data.reason);
        return apiResponse.success(res, cancelled);
      }
      case 'apply': {
        const applied = await applyCreditNoteToInvoice(companyId, parsed.data.creditNoteId, parsed.data.invoiceId, userId);
        return apiResponse.success(res, applied);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Credit note action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))));
