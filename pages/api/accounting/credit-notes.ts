/**
 * Credit Notes API
 * GET  /api/accounting/credit-notes - List credit notes (with filters); with ?id=, one note
 *   and, while it is a draft, its derived approval state (R-035)
 * POST /api/accounting/credit-notes - Create draft credit note
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import {
  getCreditNotes,
  getCreditNoteById,
  createCreditNote,
  CreditNoteLinkError,
} from '@/modules/accounting/services/ar/creditNoteService';
import type { CreditNoteStatus } from '@/modules/accounting/types/ar.types';
import { describeApprovalGate } from '@/modules/accounting/services/gl/approvalGate';
import { creditNoteApprovalType } from '@/modules/accounting/services/gl/approvalDocumentTypes';
import { CreditNoteDimensionRefusal } from '@/modules/accounting/services/ar/creditNoteHeaderTags';
import { BillLineAccountRefusal } from '@/modules/accounting/services/ap/billLineAccountGuard';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const { id, type, status, limit, offset } = req.query;
      if (id) {
        const note = await getCreditNoteById(companyId, id as string);
        if (!note) return apiResponse.notFound(res, 'Credit Note', id as string);
        // R-035: the derived approval state, under the type the note's own `type` names.
        const approval = note.status === 'draft'
          ? await describeApprovalGate(companyId, creditNoteApprovalType(note.type), note.id) : null;
        return apiResponse.success(res, { ...note, approval });
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
        creditDate, reason, subtotal, taxRate, projectId, glAccountId } = req.body;

      if (!type || !creditDate || subtotal === undefined) {
        return apiResponse.badRequest(res, 'type, creditDate, and subtotal are required');
      }
      // W1 family (P2.1): a negative subtotal posts inverted GL at approve.
      if (!(Number(subtotal) > 0)) {
        return apiResponse.badRequest(res, 'subtotal must be a positive amount');
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
        glAccountId: glAccountId || undefined,
      }, userId);

      return apiResponse.created(res, creditNote);
    } catch (err) {
      // The credit-note number is minted under the company+year number lock (migration 858): held past its 5 s
      // bound it is a 55P03, which is contention (503 + Retry-After), not a server fault.
      if (respondIfLockTimeout(res, err)) return;
      // Raised before the first write (creditNoteHeaderTags): a 400 commits nothing.
      if (err instanceof CreditNoteDimensionRefusal) return apiResponse.badRequest(res, err.message, { code: err.code });
      // Before any write: a counterparty or invoice the note may not name (FX PR0 adds a foreign invoice).
      if (err instanceof CreditNoteLinkError) return apiResponse.badRequest(res, err.message);
      // A supplier note's own account (891) held to the bill-line rule, before any write.
      if (err instanceof BillLineAccountRefusal) return apiResponse.badRequest(res, err.message, { code: err.code });
      log.error('Failed to create credit note', { error: err }, 'accounting-api');
      return apiResponse.internalError(res, err, 'Failed to create credit note');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
