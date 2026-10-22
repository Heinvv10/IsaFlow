/**
 * POST /api/accounting/netcash/resolve
 * Release a Netcash claim that holds a batch ('pending', 'unknown', 'submitted' or 'processing') once Netcash has been
 * checked. Body: { submissionId: string; outcome: 'failed' | 'submitted'; note: string }
 *   failed    - Netcash never got the batch, or rejected it: it may be sent again. Any of the four statuses.
 *   submitted - Netcash has the batch: it stays closed. pending/unknown only.
 * The operator's note is the evidence; a status poll never is.
 * Owner/admin only. See services/ap/netcashSubmissionResolve.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { jsonSafe } from '@/modules/accounting/services/ap/netcashAnswerSafety';
import { resolveSubmission, type ResolveOutcome } from '@/modules/accounting/services/ap/netcashSubmissionResolve';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE = 500;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  await assertNotImpersonating(); // R-032 L5: first, before any read or write

  const { submissionId, outcome, note } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof submissionId !== 'string' || !UUID.test(submissionId)) return apiResponse.badRequest(res, 'submissionId must be a submission id');
  if (outcome !== 'failed' && outcome !== 'submitted') return apiResponse.badRequest(res, "outcome must be 'failed' or 'submitted'");
  // Made jsonb-safe first (round 16): it is written to netcash_response.resolved and audit_log, and a NUL or a lone
  // surrogate failed the resolve (22P05).
  const trimmed = typeof note === 'string' ? jsonSafe(note).trim() : '';
  if (trimmed === '' || trimmed.length > MAX_NOTE) return apiResponse.badRequest(res, `note is required (what you found at Netcash), at most ${MAX_NOTE} characters`);

  const result = await resolveSubmission({
    companyId: req.companyId, submissionId, outcome: outcome as ResolveOutcome, note: trimmed,
    userId: req.user.id, userEmail: req.user.email ?? null,
  });
  if (result.kind === 'not_found') return apiResponse.notFound(res, 'Submission', submissionId);
  if (result.kind === 'in_flight') {
    return apiResponse.conflict(res, 'This submission is still in flight (its send has not finished). Try again in a few minutes.',
      { reason: 'IN_FLIGHT' });
  }
  if (result.kind === 'answer_pending') {
    const answered = result.file
      ? `A saved Netcash answer for this submission cannot be applied automatically (file ${result.file} in the answer spool directory is unreadable, an unfinished write, or was quarantined). `
        + 'Check Netcash for this batch: if Netcash has it, resolve this submission as submitted; if Netcash shows nothing, ask ops to move that file out of the spool directory, then resolve it as failed.'
      : result.outcome
      ? `Netcash answered ${result.outcome}${result.batchReference ? ` (reference ${result.batchReference})` : ''} for this submission, but that answer is not on it yet. Do not free it: resolve it as submitted if Netcash has the batch.`
      : "Netcash has answered this submission and the server is still recording its answer. Wait a few minutes, reload, and check the submission's status before resolving it.";
    return apiResponse.conflict(res, answered,
      { reason: 'ANSWER_PENDING_RECORD', netcashOutcome: result.outcome ?? null, batchReference: result.batchReference ?? null, spoolFile: result.file ?? null });
  }
  if (result.kind === 'changed') {
    return apiResponse.conflict(res, `This submission's status changed from ${result.from} to ${result.to} since you opened it. Reload the page and check Netcash again before resolving it.`,
      { reason: 'STATUS_CHANGED', status: result.to, previousStatus: result.from });
  }
  if (result.kind === 'not_resolvable') {
    return apiResponse.conflict(res, `This submission is ${result.status}: a pending or unknown submission can be resolved either way, a submitted or processing one as failed only, and a completed or failed one not at all.`,
      { reason: 'NOT_RESOLVABLE', status: result.status });
  }
  log.info('Netcash submission resolved', { submissionId, outcome, previousStatus: result.previousStatus, userId: req.user.id }, 'netcash-api');
  return apiResponse.success(res, { submissionId, status: outcome, previousStatus: result.previousStatus });
}

// Owner/admin only: releasing a claim can let a batch be paid again.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withAuth>[0], { allowedRoles: ['owner', 'admin'] }))));
