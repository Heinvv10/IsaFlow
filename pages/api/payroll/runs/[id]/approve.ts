/**
 * POST /api/payroll/runs/[id]/approve
 * Approve a payroll run and post its GL journal entry.
 * Body: { expectedPlanHash } — REQUIRED (BRK-596 R2-4): the planHash the
 * caller previewed (GET …/journal-plan). Without it an HTTP caller would
 * approve whatever the run holds now, not what anyone reviewed. A run that no
 * longer hashes the same is refused 409 before anything is written. (The MCP
 * tool approve_pay_run requires the hash of its own dry run in its handler;
 * the service keeps it optional only for the seed and simulation scripts.)
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import {
  withAuth,
  withCsrf,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import {
  PayrollApprovalConflictError,
  PayrollApprovalRefusedError,
  approvePayrollRun,
} from '@/modules/accounting/services/payroll/payrollApprovalService';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id);

  if (!UUID_RE.test(id)) {
    return apiResponse.badRequest(res, 'Invalid payroll run ID');
  }

  const expectedPlanHash = (req.body as { expectedPlanHash?: unknown } | undefined)?.expectedPlanHash;
  if (typeof expectedPlanHash !== 'string' || expectedPlanHash === '') {
    return apiResponse.badRequest(res, 'expectedPlanHash is required: preview the run (GET journal-plan) and send its planHash');
  }

  try {
    const result = await withJournalDateRefusal(res, () => approvePayrollRun(companyId, id, user.id, { expectedPlanHash }));
    if (result === JOURNAL_DATE_REFUSED) return;
    return apiResponse.success(res, result);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    // Only a refusal raised before the status write is a 400. withAuth COMMITs
    // a 4xx, so anything else is rethrown: it may follow the write, and the
    // 500 rolls the request back rather than stranding an approved run (K-079).
    // The 5s wait for the run or its journal ran out: raised before any write,
    // answered as calculate answers it.
    if (respondIfLockTimeout(res, err)) return;
    if (err instanceof PayrollApprovalConflictError) return apiResponse.conflict(res, err.message);
    if (err instanceof PayrollApprovalRefusedError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
