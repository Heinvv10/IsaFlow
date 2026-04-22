/**
 * GET /api/accounting/evidence/je/[jeId]
 * Returns full evidence detail for a single journal entry — header, lines, and
 * the linked captured document (if any).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { resolveJournalEntryEvidence } from '@/modules/accounting/services/core/evidenceGraphService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req;
  const jeId = req.query.jeId as string;
  if (!jeId) return apiResponse.badRequest(res, 'jeId is required');

  log.info('Fetching JE evidence', { companyId, jeId }, 'evidence-api');

  const detail = await resolveJournalEntryEvidence(companyId, jeId);

  if (!detail) return apiResponse.notFound(res, 'Journal entry', jeId);

  return apiResponse.success(res, detail);
}

export default withAuth(withErrorHandler(handler));
