/**
 * Journal Entry Detail API
 * GET /api/accounting/journal-entries-detail?id=... - Get entry with lines, and
 * `approval` (R-035 PR6): a draft's derived manual-journal approval state.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getJournalEntryById } from '@/modules/accounting/services/gl/journalEntryService';
import { describeApprovalGate } from '@/modules/accounting/services/gl/approvalGate';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;
  if (!id) return apiResponse.badRequest(res, 'id is required');

  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) return apiResponse.notFound(res, 'Journal Entry', id);
    // R-035 PR6: the derived approval state of a draft (the post route gates
    // every draft); null once it is no longer one.
    const approval = entry.status === 'draft' ? await describeApprovalGate(companyId, 'manual_journal', id) : null;
    return apiResponse.success(res, { ...entry, approval });
  } catch (err) {
    log.error('Failed to get journal entry', { id, error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to get journal entry');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
