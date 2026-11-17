/**
 * POST /api/accounting/sars/returns/[form]/filing-file  (form = vat201 | emp201)
 *   { versionId, format }   VAT201: csv | json; EMP201: csv | pdf
 * Downloads a finalised version's filing file (wave 6 EFa), built from the version's stored figures. The first download
 * stamps the version (sha256 of the capture CSV, who, when); Mark filed needs that stamp. POST because it writes the
 * stamp (CSRF). Every refusal lands before the write. Nothing is sent to SARS.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { UUID } from '@/lib/schemas/common';
import { downloadFilingFile } from '@/modules/accounting/services/returns/filingFileService';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';
import { returnFormOf } from '@/modules/accounting/services/returns/returnForm';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';

const Body = z.object({ versionId: UUID, format: z.enum(['csv', 'json', 'pdf']) });

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const form = returnFormOf(req.query.form);
  if (!form) return apiResponse.notFound(res, 'Return form');
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await checkReportRateLimit(companyId, `return-filing-file:u:${userId}`, INTERACTIVE_REPORT_LIMIT))) {
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }
  try {
    const file = await downloadFilingFile(companyId, form, parsed.data.versionId, parsed.data.format, { userId, role: companyRole });
    log.info('Return filing file downloaded', { companyId, form, versionId: parsed.data.versionId, stamped: file.stamped }, 'sars-returns');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Length', file.body.length);
    res.setHeader('X-Filing-File-Sha256', file.sha256);
    return res.status(200).send(file.body);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof ReturnRefusal) return respondReturnRefusal(res, err);
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
