/**
 * Migration AP Invoices API
 * POST /api/accounting/migration/ap-invoices
 * Body: { sessionId, invoices[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { APImportRequestSchema } from '@/modules/accounting/services/core/migrationRowSchemas';
import {
  importAPInvoices,
} from '@/modules/accounting/services/ap/migrationApService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const parsed = APImportRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { sessionId, invoices } = parsed.data;

  const result = await importAPInvoices(companyId, sessionId, invoices, userId);

  log.info('AP invoices imported', {
    companyId,
    sessionId,
    imported: result.imported,
    skipped: result.skipped,
  }, 'migration');

  return apiResponse.success(res, result);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
