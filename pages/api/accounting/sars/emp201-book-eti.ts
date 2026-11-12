/**
 * POST /api/accounting/sars/emp201-book-eti { month: 'YYYY-MM' } — "Book ETI for this month" (wave 5 ET, review round 4,
 * coordinator ruling M1(c)). Brings a run-less month's ETI journal (ETI-YYYY-MM) to what the EMP201 declares: its ETI
 * used and, in August or February, the refund (ETI Act s9(1), s10(1)). The same rebook every payroll trigger runs
 * (etiRebook.bookEtiForMonth), under the company payroll approval lock; idempotent (a month already booked posts nothing).
 * A month that has not ended, or whose run journal is in force (the run books its own ETI), posts nothing and says why.
 * Owner, admin or manager (withWriteAccess's DEFAULT_WRITE_ROLES); CSRF.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { bookEtiForMonthLocked } from '@/modules/accounting/services/payroll/etiRebook';

const BodySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM') });

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  const ym = { year: Number(parsed.data.month.slice(0, 4)), month: Number(parsed.data.month.slice(5, 7)) };
  try {
    const outcome = await bookEtiForMonthLocked(companyId, ym, userId);
    log.info('EMP201 book ETI for month', { companyId, ...outcome }, 'accounting-api');
    return apiResponse.success(res, outcome);
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return; // a pay run being approved holds lock 1: retryable
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
