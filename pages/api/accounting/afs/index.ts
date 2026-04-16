// pages/api/accounting/afs/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { listAfsDocuments, createAfsDocument } from '@/modules/accounting/services/afs/afsDocumentService';
import type { DocumentType, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    log.info('Listing AFS documents', { companyId }, 'afs-index-api');
    const documents = await listAfsDocuments(companyId);
    return apiResponse.success(res, { documents });
  }

  if (req.method === 'POST') {
    const { fiscalYear, period, documentType, reportingFramework } = req.body as {
      fiscalYear?: number;
      period?: string;
      documentType: DocumentType;
      reportingFramework: ReportingFramework;
    };

    if (!documentType || !reportingFramework) {
      return apiResponse.badRequest(res, 'documentType and reportingFramework are required');
    }

    const validDocumentTypes: DocumentType[] = ['afs', 'management_pack'];
    if (!validDocumentTypes.includes(documentType)) {
      return apiResponse.badRequest(res, `documentType must be one of: ${validDocumentTypes.join(', ')}`);
    }

    const validFrameworks: ReportingFramework[] = ['ifrs_smes', 'full_ifrs'];
    if (!validFrameworks.includes(reportingFramework)) {
      return apiResponse.badRequest(res, `reportingFramework must be one of: ${validFrameworks.join(', ')}`);
    }

    if (documentType === 'afs' && !fiscalYear) {
      return apiResponse.badRequest(res, 'fiscalYear is required for AFS documents');
    }

    if (documentType === 'management_pack' && !period) {
      return apiResponse.badRequest(res, 'period (YYYY-MM) is required for management_pack documents');
    }

    log.info('Creating AFS document', { companyId, documentType, fiscalYear, period }, 'afs-index-api');

    const document = await createAfsDocument({ companyId, fiscalYear, period, documentType, reportingFramework });
    return apiResponse.created(res, { document }, 'AFS document created');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as never));
