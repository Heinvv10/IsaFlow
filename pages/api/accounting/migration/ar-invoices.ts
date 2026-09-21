/**
 * Migration AR Invoices API
 * POST /api/accounting/migration/ar-invoices
 * Body: { sessionId, invoices[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  ARInvoiceRowSchema,
  ImportEnvelopeSchema,
  parseInvoiceRows,
} from '@/modules/accounting/services/core/migrationRowSchemas';
import {
  importARInvoices,
} from '@/modules/accounting/services/core/migrationImportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const parsed = ImportEnvelopeSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { sessionId, invoices } = parsed.data;

  // Per row, not per file: a single malformed line used to 400 the whole
  // upload with no row number. The failures travel with the rest of the run's
  // errors so the operator sees every bad line at once, by row.
  const { rows, sourceRows, errors: rowErrors } = parseInvoiceRows(
    ARInvoiceRowSchema, 'ar_invoices', invoices,
  );

  const result = await importARInvoices(companyId, sessionId, rows, userId, {
    sourceRows,
    priorErrors: rowErrors,
  });

  log.info('AR invoices imported', {
    companyId,
    sessionId,
    imported: result.imported,
    skipped: result.skipped,
  }, 'migration');

  return apiResponse.success(res, result);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
