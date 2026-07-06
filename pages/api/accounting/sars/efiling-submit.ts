/**
 * SARS eFiling VAT201 submit / status-poll.
 * POST { submissionId, action?: 'submit' | 'poll' }
 *   'submit' (default) — file the VAT201 to SARS via the ISV channel.
 *   'poll'             — refresh the SARS-reported status.
 *
 * The server re-runs the exceptions gate before filing (see
 * sarsEfilingSubmissionService) — the UI gate is a convenience, this is the
 * enforcement. Live submission is blocked on Hein's SARS ISV registration.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  submitVAT201ToSars,
  pollVAT201Status,
  EfilingNotConfiguredError,
  EfilingBlockedError,
  EfilingSubmissionNotFoundError,
  EfilingAlreadyFiledError,
} from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  const { submissionId, action } = req.body ?? {};
  if (!submissionId || typeof submissionId !== 'string') {
    return apiResponse.badRequest(res, 'submissionId is required');
  }
  const op = action === 'poll' ? 'poll' : 'submit';

  try {
    const result = op === 'poll'
      ? await pollVAT201Status(companyId, submissionId, userId)
      : await submitVAT201ToSars(companyId, submissionId, userId);
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof EfilingSubmissionNotFoundError) {
      return apiResponse.notFound(res, 'SARS submission', submissionId);
    }
    if (err instanceof EfilingNotConfiguredError) {
      return apiResponse.badRequest(res, 'SARS eFiling is not configured on this server');
    }
    if (err instanceof EfilingAlreadyFiledError) {
      // Idempotency: this return was already filed — refuse a duplicate.
      return apiResponse.conflict(res, 'This VAT201 has already been filed to SARS', {
        correlationId: err.correlationId,
      });
    }
    if (err instanceof EfilingBlockedError) {
      // "Do not file" — the differentiator. Surface the reason to the user.
      return apiResponse.badRequest(res, err.reason, { blocked: true });
    }
    // Transport / unexpected — audited inside the service; do not leak upstream detail.
    log.error('SARS eFiling operation failed', { error: err instanceof Error ? err.message : String(err), op, submissionId }, 'sars-api');
    return apiResponse.badRequestFromError(res, err, `SARS eFiling ${op} failed — see the submission audit log`);
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
