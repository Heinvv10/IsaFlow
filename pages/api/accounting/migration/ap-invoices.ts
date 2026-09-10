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
import {
  APInvoiceRowSchema,
  ImportEnvelopeSchema,
  invoiceNumberColumnUnmapped,
  parseInvoiceRows,
} from '@/modules/accounting/services/core/migrationRowSchemas';
import {
  importAPInvoices,
} from '@/modules/accounting/services/ap/migrationApService';

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

  // A blank invoice number is legitimate on the AP side; a MISSING one is a
  // mapping mistake, and the two arrive at the service looking identical. If
  // no row carries the field, the operator never mapped the column: every row
  // would import as unnumbered and de-duplicate against the others on
  // (supplier, date, total, reference), so a file of numbered bills would load
  // a fraction of itself and report the rest as already imported. Refuse the
  // whole file — loudly, and distinctly from a file that contains blanks.
  if (invoiceNumberColumnUnmapped(invoices)) {
    return apiResponse.badRequest(
      res,
      'No invoice-number column is mapped. Map it and import again — a bill with no number of its own imports fine, but the column itself has to be mapped or every row looks blank and only the first of each supplier, date and amount is taken.',
    );
  }

  // Per row, not per file: a single malformed line used to 400 the whole
  // upload with no row number. The failures travel with the rest of the run's
  // errors so the operator sees every bad line at once, by row.
  const { rows, sourceRows, errors: rowErrors } = parseInvoiceRows(
    APInvoiceRowSchema, 'ap_invoices', invoices,
  );

  const result = await importAPInvoices(companyId, sessionId, rows, userId, {
    sourceRows,
    priorErrors: rowErrors,
  });

  log.info('AP invoices imported', {
    companyId,
    sessionId,
    imported: result.imported,
    skipped: result.skipped,
  }, 'migration');

  return apiResponse.success(res, result);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
