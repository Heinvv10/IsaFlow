/**
 * GET  /api/accounting/ar/disputes?status=open|resolved|...&invoiceId=...
 * POST /api/accounting/ar/disputes  — internal user raises a dispute
 *
 * PRD-06 Phase 3. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listDisputes,
  raiseDispute,
  type DisputeStatus,
} from '@/modules/accounting/services/ar/disputeService';

const ALLOWED_STATUSES: DisputeStatus[] = ['open', 'resolved', 'withdrawn', 'rejected'];

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const invoiceIdParam =
      typeof req.query.invoiceId === 'string' ? req.query.invoiceId : undefined;

    const status =
      statusParam && (ALLOWED_STATUSES as string[]).includes(statusParam)
        ? (statusParam as DisputeStatus)
        : undefined;

    const limit = Math.min(Math.max(1, Number(req.query.limit ?? 50)), 200);
    const offset = Math.max(0, Number(req.query.offset ?? 0));

    const result = await listDisputes(companyId, {
      status,
      customerInvoiceId: invoiceIdParam,
      limit,
      offset,
    });

    apiResponse.success(res, result);
    return;
  }

  if (req.method === 'POST') {
    const body = req.body ?? {};
    const customerInvoiceId =
      typeof body.customerInvoiceId === 'string' ? body.customerInvoiceId : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const disputedAmount = Number(body.disputedAmount);
    const customerInvoiceLineId =
      typeof body.customerInvoiceLineId === 'string' && body.customerInvoiceLineId.length > 0
        ? body.customerInvoiceLineId
        : null;
    const sourceDocumentId =
      typeof body.sourceDocumentId === 'string' && body.sourceDocumentId.length > 0
        ? body.sourceDocumentId
        : null;

    if (!customerInvoiceId) {
      apiResponse.badRequest(res, 'customerInvoiceId is required');
      return;
    }
    if (!reason) {
      apiResponse.badRequest(res, 'reason is required');
      return;
    }
    if (!Number.isFinite(disputedAmount) || disputedAmount <= 0) {
      apiResponse.badRequest(res, 'disputedAmount must be a positive number');
      return;
    }

    try {
      const dispute = await raiseDispute(companyId, {
        customerInvoiceId,
        customerInvoiceLineId,
        reason,
        disputedAmount,
        raisedBy: `user:${user.id}`,
        sourceDocumentId,
      });
      apiResponse.success(res, dispute);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already an open dispute/i.test(message)) {
        res.status(409).json({
          success: false,
          error: { code: 'DISPUTE_EXISTS', message },
        });
        return;
      }
      if (
        /not found or not eligible/i.test(message) ||
        /exceeds outstanding/i.test(message) ||
        /must be greater/i.test(message) ||
        /reason is required/i.test(message)
      ) {
        apiResponse.badRequest(res, message);
        return;
      }
      throw err;
    }
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
