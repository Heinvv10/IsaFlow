// pages/api/accounting/afs/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { DocumentTypeEnum, ReportingFrameworkEnum } from '@/lib/schemas/afs';
import { log } from '@/lib/logger';
import { listAfsDocuments, createAfsDocument, AfsDocumentDuplicateError } from '@/modules/accounting/services/afs/afsDocumentService';

const CreateAfsSchema = z.object({
  fiscalYear: z.number().int().min(2000).max(2100).optional(),
  // YYYY-MM (management_pack)
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be YYYY-MM').optional(),
  documentType: DocumentTypeEnum,
  reportingFramework: ReportingFrameworkEnum,
}).strict().refine(
  v => !(v.documentType === 'afs' && !v.fiscalYear),
  { message: 'fiscalYear is required for AFS documents', path: ['fiscalYear'] },
).refine(
  v => !(v.documentType === 'management_pack' && !v.period),
  { message: 'period (YYYY-MM) is required for management_pack documents', path: ['period'] },
);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    log.info('Listing AFS documents', { companyId }, 'afs-index-api');
    const documents = await listAfsDocuments(companyId);
    return apiResponse.success(res, { documents });
  }

  if (req.method === 'POST') {
    const parsed = CreateAfsSchema.safeParse(req.body);
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const { fiscalYear, period, documentType, reportingFramework } = parsed.data;

    log.info('Creating AFS document', { companyId, documentType, fiscalYear, period }, 'afs-index-api');

    try {
      const document = await createAfsDocument({ companyId, fiscalYear, period, documentType, reportingFramework });
      return apiResponse.created(res, { document }, 'AFS document created');
    } catch (err) {
      if (err instanceof AfsDocumentDuplicateError) {
        return apiResponse.conflict(res, err.message, { existing: err.existing });
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
