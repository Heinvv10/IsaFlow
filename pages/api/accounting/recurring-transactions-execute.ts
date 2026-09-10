/**
 * Recurring Transactions Execute API — WS-8.4
 * POST — execute a template immediately
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { executeRecurring } from '@/modules/accounting/services/core/recurringTransactionService';
import { RecurringTemplateNotDueError, RecurringTemplateNotFoundError, RecurringTemplateTotalsMismatchError } from '@/modules/accounting/services/core/recurringTransactionErrors';
import { CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const { templateId } = req.body as { templateId?: string };
  if (!templateId) return apiResponse.badRequest(res, 'templateId is required');

  const userId = req.user.id;
  try {
    const result = await executeRecurring(companyId, templateId, userId);
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Recurring execute failed', { templateId, error: err }, 'recurring-execute-api');
    // ONLY the pre-write failure may be answered with a 4xx. `withAuth` COMMITs
    // the request transaction on a 4xx and ROLLBACKs only on a 5xx, so the old
    // blanket `badRequestFromError` committed whatever a half-finished run had
    // already written — and, on a numbering clash, silently threw away the
    // reservation so the next run failed identically forever.
    if (err instanceof RecurringTemplateNotFoundError) {
      return apiResponse.notFound(res, 'Active recurring template', templateId);
    }
    // Raised by the row lock, before the first INSERT, so the 4xx COMMIT is a
    // commit of nothing. NOT_DUE is the double-click / retry / re-POST answer:
    // the previous run already advanced the schedule.
    //
    // The lock TIMEOUT is deliberately NOT answered here: it is raised from
    // Postgres 55P03 like its three sibling classes, and `apiDocumentLock`
    // owns that class — rethrowing lets `withErrorHandler` answer the 503 +
    // `Retry-After: 2` a contended write path is documented to give, so a
    // client that retries on 503 retries this route too.
    if (err instanceof RecurringTemplateNotDueError) {
      return apiResponse.conflict(res, err.message, { nextRunDate: err.nextRunDate });
    }
    // Also pre-write: the mint functions assert the template's aggregate
    // against its lines before they touch anything. 400 rather than a 500,
    // because the operator has to re-save the template — it is not a bug.
    if (err instanceof RecurringTemplateTotalsMismatchError) {
      return apiResponse.badRequest(res, err.message);
    }
    // R-067, also pre-write: the template's clientId is not a customer of this
    // company (or not a UUID at all). The operator has to re-pick the customer.
    if (err instanceof CustomerNotInCompanyError) {
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
