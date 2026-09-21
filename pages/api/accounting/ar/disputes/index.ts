/**
 * GET  /api/accounting/ar/disputes?status=open|resolved|...&invoiceId=...
 * POST /api/accounting/ar/disputes  — internal user raises a dispute
 *
 * PRD-06 Phase 3. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import {
  ArRequestError,
  listDisputes,
  raiseDispute,
  type DisputeStatus,
} from '@/modules/accounting/services/ar/disputeService';

const ALLOWED_STATUSES: DisputeStatus[] = ['open', 'resolved', 'withdrawn', 'rejected'];

const RaiseDisputeSchema = z.object({
  customerInvoiceId: UUID,
  customerInvoiceLineId: UUID.nullable().optional(),
  reason: z.string().trim().min(1).max(2000),
  disputedAmount: z.union([z.number(), z.string()]).transform(v => Number(v)).refine(n => Number.isFinite(n) && n > 0, {
    message: 'disputedAmount must be a positive number',
  }),
  sourceDocumentId: UUID.nullable().optional(),
}).strict();

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
    const parsed = RaiseDisputeSchema.safeParse(req.body);
    if (!parsed.success) {
      apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
      return;
    }
    const {
      customerInvoiceId, reason, disputedAmount,
      customerInvoiceLineId, sourceDocumentId,
    } = parsed.data;

    try {
      const dispute = await raiseDispute(companyId, {
        customerInvoiceId,
        customerInvoiceLineId: customerInvoiceLineId ?? null,
        reason,
        disputedAmount,
        raisedBy: `user:${user.id}`,
        sourceDocumentId: sourceDocumentId ?? null,
      });
      apiResponse.success(res, dispute);
    } catch (err) {
      // Typed, not text-matched — see the note in resolve.ts.
      if (err instanceof ArRequestError) {
        if (err.status === 409) {
          res.status(409).json({
            success: false,
            error: { code: err.code, message: err.message },
          });
          return;
        }
        apiResponse.badRequest(res, err.message);
        return;
      }
      throw err;
    }
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
