/**
 * GL Import API
 * POST /api/accounting/gl-import
 * Imports pre-validated rows as journal entries.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { importJournalEntries, type ImportRow } from '@/modules/accounting/services/glImportService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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
    const message = err instanceof Error ? err.message : 'Import failed';
    log.error('Failed to import journal entries', { error: err }, 'gl-import-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
