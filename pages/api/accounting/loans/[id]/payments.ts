/**
 * Loan Payments API
 * GET  — list payments recorded against a loan
 * POST — record a new cash payment (splits principal / interest, posts GL journal)
 *
 * Body for POST:
 *   { paymentDate: string (yyyy-mm-dd), periodNumber?: number, bankAccountId?: string }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listLoanPayments,
  recordLoanPayment,
  type LoanPaymentInput,
} from '@/modules/accounting/services/loans/loanPaymentService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const loanId = String(req.query.id);

  if (!UUID_RE.test(loanId)) {
    return apiResponse.badRequest(res, 'Invalid loan ID');
  }

  if (req.method === 'GET') {
    const payments = await listLoanPayments(companyId, loanId);
    return apiResponse.success(res, payments);
  }

  if (req.method === 'POST') {
    const body = req.body as Partial<LoanPaymentInput>;

    if (!body.paymentDate || !DATE_RE.test(body.paymentDate)) {
      return apiResponse.badRequest(res, 'paymentDate (yyyy-mm-dd) is required');
    }

    if (body.periodNumber !== undefined && (
      !Number.isInteger(body.periodNumber) || body.periodNumber <= 0
    )) {
      return apiResponse.badRequest(res, 'periodNumber must be a positive integer');
    }

    if (body.bankAccountId !== undefined && !UUID_RE.test(body.bankAccountId)) {
      return apiResponse.badRequest(res, 'bankAccountId must be a valid UUID');
    }

    const input: LoanPaymentInput = {
      paymentDate: body.paymentDate,
      periodNumber: body.periodNumber,
      bankAccountId: body.bankAccountId,
    };

    const result = await recordLoanPayment(companyId, loanId, input, userId);
    return apiResponse.created(res, result);
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
