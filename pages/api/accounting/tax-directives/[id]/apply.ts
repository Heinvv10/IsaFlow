/**
 * POST /api/accounting/tax-directives/[id]/apply
 *
 * Applies an approved SARS tax directive — disburses the lump-sum net of PAYE,
 * posts the GL journal (DR 5200 / CR 2140 / CR 1110), and records the payment.
 *
 * Body: { paymentDate: 'YYYY-MM-DD', bankAccountId?: string }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import { applyTaxDirective } from '@/modules/accounting/services/payroll/taxDirectivePaymentService';
import { log } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.badRequest(res, 'Method not allowed — use POST');
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const directiveId = String(req.query.id);

  if (!UUID_RE.test(directiveId)) {
    return apiResponse.notFound(res, 'TaxDirective', directiveId);
  }

  const { paymentDate, bankAccountId } = req.body as {
    paymentDate?: string;
    bankAccountId?: string;
  };

  if (!paymentDate || !DATE_RE.test(paymentDate)) {
    return apiResponse.badRequest(res, 'paymentDate is required in YYYY-MM-DD format');
  }

  if (bankAccountId !== undefined && !UUID_RE.test(bankAccountId)) {
    return apiResponse.badRequest(res, 'bankAccountId must be a valid UUID');
  }

  log.info('applyTaxDirective request', { companyId, directiveId, paymentDate }, 'taxDirective');

  const result = await applyTaxDirective(
    companyId,
    directiveId,
    { paymentDate, bankAccountId },
    user.id,
  );

  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
