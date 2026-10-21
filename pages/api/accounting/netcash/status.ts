/**
 * GET /api/accounting/netcash/status?submissionId=
 * Poll Netcash for the current status of a submission.
 * Moves a live row between submitted / processing / completed. The answer itself is kept on the row as a display hint
 * (netcash_response.latestPoll, and pollFailure while it reads as a failure) - never as evidence for freeing a batch
 * (netcash/resolve does not read it). Owner/admin/write roles only, and never from a Login-as session.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { canWrite } from '@/lib/auth/writeRoles';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSubmissionStatus } from '@/modules/accounting/services/ap/netcashService';
import { jsonSafe } from '@/modules/accounting/services/ap/netcashAnswerSafety';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

const FAILURE_LEAD = new Set(['unsuccessful', 'fail', 'failed', 'failure', 'reject', 'rejected', 'error', 'errored', 'declined']);
/** The whole answer, exactly: "Completed - 2 payments unpaid" or "Successful (1 returned)" is not a completion. */
const COMPLETED_EXACT = new Set(['complete', 'completed', 'successful']);
/** A poll moves a row forwards only: an answer that would move it back keeps the row where it is. */
const PROGRESS: Record<string, number> = { submitted: 0, processing: 1, completed: 2 };

/**
 * Map Netcash's free-text status to our enum. A failure by its LEADING word, checked first ("Processing - 0 errors"
 * is not one, "Unsuccessful" and "Rejected: invalid account" are); 'completed' only on an exact completion word with
 * nothing after it; 'submitted' by its leading word; anything else is ambiguous and stays 'processing' - a live row
 * the operator can poll again or resolve.
 */
function mapNetcashStatus(raw: string): string {
  const s = raw.trim().toLowerCase();
  const lead = /^[a-z]+/.exec(s)?.[0] ?? '';
  if (FAILURE_LEAD.has(lead)) return 'failed';
  if (COMPLETED_EXACT.has(s)) return 'completed';
  if (lead === 'submitted') return 'submitted';
  return 'processing';
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  await assertNotImpersonating(); // R-032 L5: a poll calls Netcash and writes the row; first, before any read or write

  const { companyId } = req;
  const { submissionId } = req.query;
  if (!submissionId) return apiResponse.badRequest(res, 'submissionId query param is required');
  if (typeof submissionId !== 'string' || !UUID.test(submissionId)) return apiResponse.badRequest(res, 'submissionId must be a submission id');

  // Load submission — company-scoped
  const submissions = await sql`
    SELECT id, batch_reference, status
    FROM netcash_submissions
    WHERE id = ${String(submissionId)}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  ` as Row[];

  const submission = submissions[0];
  if (!submission) return apiResponse.notFound(res, 'Submission', String(submissionId));

  // If already terminal, return stored status without polling
  if (TERMINAL_STATUSES.has(String(submission.status))) {
    return apiResponse.success(res, {
      submissionId,
      status: submission.status,
      detail: 'Already in terminal state',
      polled: false,
    });
  }

  // 'unknown' / 'pending' (submit.ts): Netcash never gave a reference (batch_reference is our own batch number), so
  // there is nothing to poll. The batch stays claimed until someone has checked Netcash.
  if (submission.status === 'unknown' || submission.status === 'pending') {
    return apiResponse.success(res, {
      submissionId,
      status: submission.status,
      detail: 'Outcome not recorded - check Netcash before resubmitting',
      polled: false,
    });
  }

  if (!submission.batch_reference) {
    return apiResponse.success(res, {
      submissionId,
      status: submission.status,
      detail: 'No batch reference available for polling',
      polled: false,
    });
  }

  // A poll calls Netcash and writes the row: write-access roles only. A read-only member (this is a GET, so
  // withWriteAccess does not apply) is shown what is stored.
  if (!canWrite(req.companyRole)) {
    return apiResponse.success(res, {
      submissionId,
      status: submission.status,
      detail: 'Checking Netcash needs write access; the stored status is shown',
      polled: false,
    });
  }

  // Load company credentials
  const companies = await sql`
    SELECT netcash_service_key FROM companies WHERE id = ${companyId}::UUID LIMIT 1
  ` as Row[];
  const serviceKey = String(companies[0]?.netcash_service_key ?? '').trim();
  // No key, no poll and no write: nothing stands in for Netcash's answer (AP-01 round 10).
  if (!serviceKey) {
    return apiResponse.success(res, {
      submissionId,
      status: submission.status,
      detail: 'Netcash credentials are not configured for this company; the stored status is shown',
      polled: false,
    });
  }

  const pollResult = await getSubmissionStatus(serviceKey, String(submission.batch_reference));
  const answeredAt = new Date().toISOString(); // when Netcash answered: orders this poll against an overlapping one

  // No answer (an HTTP or network error, an unreadable body, no status): nothing of Netcash's to apply or keep as its
  // answer (AP-01 round 11 - 'unknown' mapped to processing and was stored as latestPoll). Only a pollError hint is
  // merged, compare-and-set like the answer below; the status and latestPoll stay as they are.
  if (!pollResult.answered) {
    const pollError = JSON.stringify(jsonSafe({ pollError: { detail: pollResult.detail, at: answeredAt } }));
    await sql`
      UPDATE netcash_submissions
      SET netcash_response = COALESCE(netcash_response, '{}'::JSONB) || ${pollError}::JSONB
      WHERE id = ${String(submissionId)}::UUID AND company_id = ${companyId}::UUID AND status = ${String(submission.status)}
        AND COALESCE((netcash_response -> 'pollError' ->> 'at')::TIMESTAMPTZ, '-infinity'::TIMESTAMPTZ) < ${answeredAt}::TIMESTAMPTZ
    `;
    log.warn('Netcash status poll got no answer - nothing changed', { submissionId, detail: pollResult.detail }, 'netcash-api');
    return apiResponse.success(res, {
      submissionId,
      status: submission.status,
      detail: `Netcash did not answer (${pollResult.detail}). Nothing was changed - try again later.`,
      polled: false,
    });
  }
  const mapped = mapNetcashStatus(pollResult.status);

  // AP-01: a poll never moves a live submission to 'failed'. 'failed' leaves the unique index that closes the batch
  // (migration 898), and free text does not prove Netcash dropped what it accepted. The row stays as it is, the poll
  // is kept as a hint, and an operator checks Netcash and resolves it (netcash/resolve, see .claude.md).
  const flagged = mapped === 'failed';
  const current = String(submission.status);
  const newStatus = flagged || (PROGRESS[mapped] ?? 0) < (PROGRESS[current] ?? 0) ? current : mapped;
  if (flagged) {
    log.error('Netcash status poll reports a failure for a live submission - left as is, operator must check Netcash', {
      submissionId, status: newStatus, netcashStatus: pollResult.status, detail: pollResult.detail,
    }, 'netcash-api');
  }

  // The answer is a display hint only (nothing gates on it). It is MERGED into netcash_response (keys written since
  // the read above - lateSendResult, resolved - survive), pollFailure is dropped unless this answer reads as one, and
  // the write is compare-and-set twice: on the status read above (a settle, a resolution or another poll's move is
  // never overwritten), and on the stored answer being older than this one (an overlapping poll that Netcash answered
  // earlier but that writes later changes nothing). Both answers are timed by this host's clock. 0 rows is a no-op.
  const hint: Record<string, unknown> = { latestPoll: { ...pollResult, at: answeredAt } };
  if (flagged) hint.pollFailure = { status: pollResult.status, detail: pollResult.detail, at: answeredAt };
  const written = await sql`
    UPDATE netcash_submissions
    SET status = ${newStatus},
        netcash_response = (COALESCE(netcash_response, '{}'::JSONB) - 'pollFailure' - 'pollError') || ${JSON.stringify(jsonSafe(hint))}::JSONB /* Netcash's text made safe for jsonb (round 15) */
    WHERE id = ${String(submissionId)}::UUID AND company_id = ${companyId}::UUID AND status = ${String(submission.status)}
      AND COALESCE((netcash_response -> 'latestPoll' ->> 'at')::TIMESTAMPTZ, '-infinity'::TIMESTAMPTZ) < ${answeredAt}::TIMESTAMPTZ
    RETURNING id
  ` as Row[];
  if (written.length === 0) {
    const now = await sql`
      SELECT status FROM netcash_submissions WHERE id = ${String(submissionId)}::UUID AND company_id = ${companyId}::UUID
    ` as Row[];
    log.info('Netcash status poll skipped: the submission changed, or a newer answer was stored, while it was being checked', {
      submissionId, read: submission.status, now: now[0]?.status,
    }, 'netcash-api');
    return apiResponse.success(res, {
      submissionId,
      status: now[0]?.status ?? submission.status,
      detail: 'The submission changed, or a newer check was recorded, while this one waited on Netcash; its current status is shown.',
      polled: false,
    });
  }

  log.info('Netcash status polled', { submissionId, newStatus, detail: pollResult.detail }, 'netcash-api');

  return apiResponse.success(res, {
    submissionId,
    status: newStatus,
    detail: flagged
      ? `Netcash reports a failure (${pollResult.status}). The batch stays closed: check Netcash before it is released.`
      : pollResult.detail,
    needsAttention: flagged,
    polled: true,
  });
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
