/**
 * SARS Submissions API
 * GET  — list all submissions (optional ?type=VAT201)
 * POST { id, action: 'mark_submitted', reference } — mark as submitted
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  listSubmissions,
  markSubmitted,
  getSubmission,
} from '@/modules/accounting/services/sarsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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

      try {
        const submission = await markSubmitted(companyId, id, reference);
        return apiResponse.success(res, submission, 'Submission marked as submitted');
      } catch (err) {
        log.error('Failed to mark submission', { error: err }, 'sars-api');
        return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed');
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
