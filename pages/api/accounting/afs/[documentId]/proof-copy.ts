// pages/api/accounting/afs/[documentId]/proof-copy.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { exportToPdf } from '@/modules/accounting/services/afs/pdfExportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const documentId = req.query.documentId as string;

  log.info('Generating AFS proof copy', { companyId, documentId }, 'afs-proof-copy-api');

  const buffer = await exportToPdf(documentId, companyId, {
    watermark: 'DRAFT — NOT FOR DISTRIBUTION',
    skipChecks: true,
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="proof-${documentId}.pdf"`);
  return res.status(200).send(buffer);
}

export default withAuth(withErrorHandler(handler as never));
