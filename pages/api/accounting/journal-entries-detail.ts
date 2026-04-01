/**
 * Journal Entry Detail API
 * GET /api/accounting/journal-entries-detail?id=... - Get entry with lines
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getJournalEntryById } from '@/modules/accounting/services/journalEntryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const id = req.query.id as string;
  if (!id) return apiResponse.badRequest(res, 'id is required');

  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) return apiResponse.notFound(res, 'Journal Entry', id);
    return apiResponse.success(res, entry);
  } catch (err) {
    log.error('Failed to get journal entry', { id, error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to get journal entry');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
