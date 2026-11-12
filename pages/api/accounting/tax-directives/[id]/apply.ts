/**
 * POST /api/accounting/tax-directives/[id]/apply
 *
 * Applies an approved SARS tax directive — disburses the lump-sum net of PAYE,
 * posts the GL journal (DR labour, split and CC1-tagged as a pay run's —
 * taxDirectivePaymentService / CR 2140 / CR 1110), and records the payment.
 * 409 TAX_DIRECTIVE_SPLIT_CHANGED: the cost-centre split changed while paying; retry.
 *
 * Body: { paymentDate: 'YYYY-MM-DD', bankAccountId?: string }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  TaxDirectiveAlreadyAppliedError, TaxDirectiveNotApprovedError, TaxDirectiveSplitChangedError,
  TaxDirectiveWithoutEmployeeError, TaxDirectiveNotLumpSumError,
} from '@/modules/accounting/services/payroll/taxDirectivePaymentService';
// The payment plus its month's ETI journal, refused while a later ETI month is posted (wave 5 ET: H2, R-A, R-C).
import { applyTaxDirective } from '@/modules/accounting/services/payroll/directivePaymentEti';
import { EtiLaterMonthPostedError } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { isBankAccountRefusal } from '@/modules/accounting/services/gl/paymentBankAccount';
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

  let result: Awaited<ReturnType<typeof applyTaxDirective>> | typeof JOURNAL_DATE_REFUSED;
  try {
    result = await withJournalDateRefusal(res, () => applyTaxDirective(
      companyId,
      directiveId,
      { paymentDate, bankAccountId },
      user.id,
    ));
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return;
    // Raised before anything is written (taxDirectivePaymentService), so the
    // 409 withAuth commits leaves nothing half-applied.
    if (err instanceof EtiLaterMonthPostedError) return apiResponse.conflict(res, err.message, { code: 'ETI_LATER_MONTH_POSTED' });
    if (err instanceof TaxDirectiveAlreadyAppliedError) return apiResponse.conflict(res, err.message);
    if (err instanceof TaxDirectiveNotApprovedError) return apiResponse.conflict(res, err.message);
    if (err instanceof TaxDirectiveWithoutEmployeeError) return apiResponse.badRequest(res, err.message);
    if (err instanceof TaxDirectiveNotLumpSumError) return apiResponse.badRequest(res, err.message);
    if (isBankAccountRefusal(err)) return apiResponse.badRequest(res, err.message);
    if (err instanceof TaxDirectiveSplitChangedError) return apiResponse.conflict(res, err.message, { code: err.code, retryable: true });
    throw err;
  }
  if (result === JOURNAL_DATE_REFUSED) return;

  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
