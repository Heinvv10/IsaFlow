/**
 * Approval Requests API
 * GET  — list requests (optional ?status=pending)
 * POST — create request or decide on request
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listRequests, requestApproval, decideRequest, checkApproval, getPendingCount,
  type ApprovalStatus, type DocumentType,
} from '@/modules/accounting/services/gl/approvalService';
import {
  ApprovalDecisionError, ApprovalNotRequiredError, ApprovalRuleNotFoundError,
  ApprovalRequestNotFoundError,
} from '@/modules/accounting/services/gl/approvalAuthority';
import { isUuidParam } from '@/lib/validation';

const DOCUMENT_TYPES = new Set<DocumentType>(['customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note']);
const isDocumentType = (value: unknown): value is DocumentType => typeof value === 'string' && DOCUMENT_TYPES.has(value as DocumentType);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const status = req.query.status as ApprovalStatus | undefined;

    if (req.query.action === 'check') {
      const { documentType, documentId, amount } = req.query;
      if (!documentType || !documentId) {
        return apiResponse.badRequest(res, 'documentType and documentId are required');
      }
      if (!isDocumentType(documentType)) {
        return apiResponse.badRequest(res, 'Invalid documentType');
      }
      // checkApproval casts it `::UUID`; unchecked that is a 22P02 and a 500.
      if (!isUuidParam(documentId)) {
        return apiResponse.badRequest(res, 'documentId must be a UUID');
      }
      const result = await checkApproval(
        companyId,
        documentType,
        documentId as string,
        Number(amount) || 0
      );
      return apiResponse.success(res, result);
    }

    if (req.query.action === 'count') {
      const count = await getPendingCount(companyId);
      return apiResponse.success(res, { count });
    }

    const requests = await listRequests(companyId, status);
    return apiResponse.success(res, { items: requests });
  }

  if (req.method === 'POST') {
    const { action } = req.body;

    if (action === 'request') {
      // No `ruleId`: the governing rule is resolved server-side from the document
      // and its amount. Letting the caller name it meant the requester chose which
      // rule constrained their own request — an admin blocked from weakening the
      // owner-only rule just created a manager-level one and named that instead.
      const { documentType, documentId, documentReference, amount } = req.body;
      if (!documentType || !documentId) {
        return apiResponse.badRequest(res, 'documentType and documentId are required');
      }
      if (!isDocumentType(documentType)) {
        return apiResponse.badRequest(res, 'Invalid documentType');
      }
      // Cast `::UUID` downstream. Unchecked, a malformed id is a 22P02 from
      // inside the transaction — a 500 and a logged stack for a bad request.
      if (!isUuidParam(documentId)) return apiResponse.badRequest(res, 'documentId must be a UUID');
      try {
        const request = await requestApproval(companyId, {
          documentType, documentId, documentReference, amount, requestedBy: userId,
        });
        return apiResponse.success(res, request);
      } catch (error) {
        // Nothing to approve, or a rule that vanished between the resolve and the
        // insert: both are bad requests, not faults.
        if (error instanceof ApprovalNotRequiredError || error instanceof ApprovalRuleNotFoundError) {
          return apiResponse.badRequest(res, error.message);
        }
        throw error;
      }
    }

    if (action === 'approve' || action === 'reject') {
      const { requestId, notes } = req.body;
      if (!requestId) return apiResponse.badRequest(res, 'requestId is required');
      // An id that is not a UUID names no request, so it gets the same answer as
      // one that names a request this company cannot see — the contract the
      // fix document states. Unchecked it was a 22P02 and a 500.
      if (!isUuidParam(requestId)) {
        return apiResponse.notFound(res, `Approval request ${requestId} not found or already decided`);
      }
      const decision = action === 'approve' ? 'approved' : 'rejected';
      try {
        const result = await decideRequest(companyId, requestId, decision, userId, notes);
        return apiResponse.success(res, result);
      } catch (error) {
        // Segregation-of-duties refusals are a 403, not a 500 — withAuth would
        // otherwise roll back and report a server fault for a policy decision.
        if (error instanceof ApprovalDecisionError) {
          return apiResponse.error(res, ErrorCode.FORBIDDEN, error.message, { reason: error.code });
        }
        // Losing a decide race, or naming an unknown request, is an ordinary
        // outcome — a 404, not the 500 a bare Error used to produce.
        if (error instanceof ApprovalRequestNotFoundError) {
          return apiResponse.notFound(res, error.message);
        }
        throw error;
      }
    }

    return apiResponse.badRequest(res, 'Invalid action. Use: request, approve, reject');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
