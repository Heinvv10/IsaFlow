/**
 * GL Import API
 * POST /api/accounting/gl-import
 * Imports pre-validated rows as journal entries.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { importJournalEntries, type ImportRow } from '@/modules/accounting/services/gl/glImportService';
import { ImportValidationError } from '@/modules/accounting/services/gl/glImportExecuteService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { rows, postImmediately } = req.body as {
    rows: ImportRow[];
    postImmediately: boolean;
  };

  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return apiResponse.badRequest(res, 'rows must be a non-empty array');
  }

  if (rows.length > 5000) {
    return apiResponse.badRequest(res, 'Maximum 5000 rows per import');
  }

  const userId = req.user.id;

  try {
    const result = await importJournalEntries(
      companyId,
      rows,
      userId,
      postImmediately === true,
    );
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to import journal entries', { error: err }, 'gl-import-api');
    // Only file-validation problems may be answered with a 400. They are raised
    // while resolving the file, before the first entry is written.
    //
    // Anything else happened mid-write — entries may already be created and
    // posted. withAuth finalises on `statusCode >= 500`, so a 400 here would
    // COMMIT that partial import while telling the user it failed, and the
    // re-upload would post the committed prefix a second time (this path has no
    // idempotency key). Propagate so the request 500s and rolls back.
    if (err instanceof ImportValidationError) {
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
