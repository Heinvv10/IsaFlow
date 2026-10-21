/**
 * POST /api/accounting/sage-connect/import
 * Body: { pullId } — a review from /preview.
 *
 * Imports the reviewed Sage data through the migration wizard's take-on steps
 * (see sageTakeOnImportService). One transaction: if any step fails, nothing
 * is kept. A journal-date refusal (locked period) answers 400 after rolling
 * back, like every other route that posts.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { importSagePull, SageImportRefused } from '@/modules/accounting/services/sage/sageTakeOnImportService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const pullId = String((req.body ?? {}).pullId ?? '');
  if (!UUID_RE.test(pullId)) return apiResponse.validationError(res, { pullId: 'Review the Sage data first' });

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  try {
    const outcome = await withJournalDateRefusal(res, () => importSagePull(companyId, userId, pullId));
    if (outcome === JOURNAL_DATE_REFUSED) return;
    return apiResponse.success(res, outcome);
  } catch (err) {
    if (err instanceof SageImportRefused) {
      log.warn('Sage import refused', { companyId, pullId, reason: err.message, issues: err.issues.length }, 'migration');
      return apiResponse.badRequest(res, err.message, { issues: err.issues });
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
