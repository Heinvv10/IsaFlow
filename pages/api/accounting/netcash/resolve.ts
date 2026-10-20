/**
 * POST /api/accounting/netcash/resolve
 * Release a Netcash claim that holds a batch ('pending' or 'unknown') once Netcash has been checked.
 * Body: { submissionId: string; outcome: 'failed' | 'submitted'; note: string }
 *   failed    - Netcash never got the batch: it may be sent again.
 *   submitted - Netcash has the batch: it stays closed.
 * Owner/admin only. See services/ap/netcashSubmissionResolve.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { resolveSubmission, type ResolveOutcome } from '@/modules/accounting/services/ap/netcashSubmissionResolve';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE = 500;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  await assertNotImpersonating(); // R-032 L5: first, before any read or write

  const { submissionId, outcome, note } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof submissionId !== 'string' || !UUID.test(submissionId)) return apiResponse.badRequest(res, 'submissionId must be a submission id');
  if (outcome !== 'failed' && outcome !== 'submitted') return apiResponse.badRequest(res, "outcome must be 'failed' or 'submitted'");
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed === '' || trimmed.length > MAX_NOTE) return apiResponse.badRequest(res, `note is required (what you found at Netcash), at most ${MAX_NOTE} characters`);

  const result = await resolveSubmission({
    companyId: req.companyId, submissionId, outcome: outcome as ResolveOutcome, note: trimmed,
    userId: req.user.id, userEmail: req.user.email ?? null,
  });
  if (result.kind === 'not_found') return apiResponse.notFound(res, 'Submission', submissionId);
  if (result.kind === 'not_resolvable') {
    return apiResponse.conflict(res, `This submission is ${result.status}: only a pending or unknown submission can be resolved.`,
      { reason: 'NOT_RESOLVABLE', status: result.status });
  }
  log.info('Netcash submission resolved', { submissionId, outcome, previousStatus: result.previousStatus, userId: req.user.id }, 'netcash-api');
  return apiResponse.success(res, { submissionId, status: outcome, previousStatus: result.previousStatus });
}

// Owner/admin only: releasing a claim can let a batch be paid again.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withAuth>[0], { allowedRoles: ['owner', 'admin'] }))));
