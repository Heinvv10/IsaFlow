// pages/api/accounting/afs/[documentId]/sections/[sectionId]/regenerate.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { generateSection } from '@/modules/accounting/services/afs/noteEngineService';
import type { ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);

  const { companyId } = req as CompanyApiRequest;
  const { documentId, sectionId } = req.query as { documentId: string; sectionId: string };
  const { fiscalYear, framework } = req.body as { fiscalYear?: unknown; framework?: unknown };

  // Validation
  const fy = Number(fiscalYear);
  const currentYear = new Date().getFullYear();
  if (!Number.isInteger(fy) || fy < 2000 || fy > currentYear + 1) {
    return apiResponse.badRequest(res, 'fiscalYear must be a number between 2000 and ' + (currentYear + 1));
  }
  if (framework !== 'ifrs_for_smes' && framework !== 'full_ifrs') {
    return apiResponse.badRequest(res, "framework must be 'full_ifrs' or 'ifrs_for_smes'");
  }

  log.info('Regenerating AFS section', { companyId, documentId, sectionId }, 'afs/regenerate');

  await generateSection(companyId, documentId, sectionId, fy, framework as ReportingFramework);

  return apiResponse.success(res, { sectionId });
}

export default withCompany(withErrorHandler(handler as never));
