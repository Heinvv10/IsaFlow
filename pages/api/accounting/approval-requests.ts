/**
 * Approval Requests API
 * GET  — list requests (optional ?status=pending)
 * POST — create request or decide on request
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listRequests, requestApproval, decideRequest, checkApproval, getPendingCount,
  type ApprovalStatus, type DocumentType,
} from '@/modules/accounting/services/gl/approvalService';

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
      const { ruleId, documentType, documentId, documentReference, amount } = req.body;
      if (!ruleId || !documentType || !documentId) {
        return apiResponse.badRequest(res, 'ruleId, documentType, and documentId are required');
      }
      const request = await requestApproval(companyId, {
        ruleId, documentType, documentId, documentReference, amount, requestedBy: userId,
      });
      return apiResponse.success(res, request);
    }

    if (action === 'approve' || action === 'reject') {
      const { requestId, notes } = req.body;
      if (!requestId) return apiResponse.badRequest(res, 'requestId is required');
      const decision = action === 'approve' ? 'approved' : 'rejected';
      const result = await decideRequest(companyId, requestId, decision, userId, notes);
      return apiResponse.success(res, result);
    }

    return apiResponse.badRequest(res, 'Invalid action. Use: request, approve, reject');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
