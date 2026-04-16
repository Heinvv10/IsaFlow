// pages/api/accounting/afs/[documentId]/proof-copy-checklist.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getProofCopyChecklist,
  ProofChecklistError,
} from '@/modules/accounting/services/afs/afsProofCopyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const documentId = req.query.documentId as string;

  log.info('Proof copy checklist requested', { companyId, documentId }, 'afs-proof-checklist-api');

  try {
    const checklist = await getProofCopyChecklist(companyId, documentId);
    return apiResponse.success(res, checklist);
  } catch (err) {
    if (err instanceof ProofChecklistError && err.code === 'NOT_FOUND') {
      return apiResponse.notFound(res, 'AFS document', documentId);
    }
    throw err;
  }
}

export default withCompany(withErrorHandler(handler as never));
