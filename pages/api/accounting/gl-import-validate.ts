/**
 * GL Import Validate API
 * POST /api/accounting/gl-import-validate
 * Validates rows without importing — returns per-row errors/warnings and summary.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { validateImportRows, type ImportRow } from '@/modules/accounting/services/glImportService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { rows } = req.body as { rows: ImportRow[] };

  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return apiResponse.badRequest(res, 'rows must be a non-empty array');
  }

  if (rows.length > 5000) {
    return apiResponse.badRequest(res, 'Maximum 5000 rows per import');
  }

  try {
    const result = await validateImportRows(companyId, rows);
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to validate import rows', { error: err }, 'gl-import-api');
    return apiResponse.badRequest(res, 'Validation failed — please check your file');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
