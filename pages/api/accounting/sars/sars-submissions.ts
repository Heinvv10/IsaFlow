/**
 * SARS Submissions API
 * GET  — list all submissions (optional ?type=VAT201)
 * POST { id, action: 'mark_submitted', reference, overrideReason? } — mark as submitted
 *
 * For a VAT201 submission, mark_submitted refuses when getVatExceptions
 * reports blocking exceptions for the submission's period, UNLESS the caller
 * is owner/admin and supplies a non-empty overrideReason (recorded, migration
 * 704). Never consulted by the ISV filing gate, which stays absolute.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withSavepoint } from '@/lib/neon';
import {
  withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listSubmissions,
  markSubmitted,
  getSubmission,
} from '@/modules/accounting/services/reports/sarsService';
import {
  assertVatGateClear, VatGateBlockedError, VatGateOverrideForbiddenError,
} from '@/modules/accounting/services/reports/vatGateOverrideService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const formType = req.query.type as string | undefined;
      const submissions = await listSubmissions(companyId, formType);
      return apiResponse.success(res, { items: submissions });
    } catch (err) {
      log.error('Failed to list submissions', { error: err }, 'sars-api');
      return apiResponse.badRequest(res, 'Failed to list submissions');
    }
  }

  if (req.method === 'POST') {
    const { id, action, reference } = req.body;

    if (!id || !action) {
      return apiResponse.badRequest(res, 'id and action are required');
    }

    if (action === 'mark_submitted') {
      if (!reference) {
        return apiResponse.badRequest(res, 'reference is required when marking as submitted');
      }
      const { overrideReason } = req.body as { overrideReason?: string };

      try {
        const existing = await getSubmission(companyId, id);
        if (!existing) return apiResponse.notFound(res, 'Submission', id);

        // Blocking VAT exceptions gate — VAT201 only, and only when the ISV
        // channel was not used to file it (this route is the manual path).
        // The override record and the markSubmitted write run in ONE
        // savepoint: if markSubmitted then fails, the override row rolls
        // back with it — an override must never stand for a submission that
        // was never actually marked submitted.
        const submission = await withSavepoint('vat_gate_mark_submitted', async () => {
          if (existing.formType === 'VAT201') {
            const userId = (req as AuthenticatedNextApiRequest).user.id;
            const companyRole = (req as CompanyAuthedRequest).companyRole;
            await assertVatGateClear(
              companyId, existing.periodStart, existing.periodEnd, 'sars_submission', id,
              { userId, role: companyRole }, overrideReason,
            );
          }
          return markSubmitted(companyId, id, reference);
        });
        return apiResponse.success(res, submission, 'Submission marked as submitted');
      } catch (err) {
        if (err instanceof VatGateOverrideForbiddenError) return apiResponse.forbidden(res, err.message);
        if (err instanceof VatGateBlockedError) return apiResponse.badRequest(res, err.message, { counts: err.counts });
        log.error('Failed to mark submission', { error: err }, 'sars-api');
        return apiResponse.badRequestFromError(res, err, 'Failed');
      }
    }

    if (action === 'get') {
      try {
        const submission = await getSubmission(companyId, id);
        if (!submission) {
          return apiResponse.notFound(res, 'Submission', id);
        }
        return apiResponse.success(res, submission);
      } catch (err) {
        log.error('Failed to get submission', { error: err }, 'sars-api');
        return apiResponse.badRequest(res, 'Failed to retrieve submission');
      }
    }

    return apiResponse.badRequest(res, `Unknown action: ${action}`);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
