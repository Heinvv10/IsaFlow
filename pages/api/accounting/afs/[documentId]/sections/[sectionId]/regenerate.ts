// pages/api/accounting/afs/[documentId]/sections/[sectionId]/regenerate.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { generateSection } from '@/modules/accounting/services/afs/noteEngineService';

const BodySchema = z.object({
  fiscalYear: z.union([z.number(), z.string()]).transform(v => Number(v)).refine(
    n => Number.isInteger(n) && n >= 2000 && n <= new Date().getFullYear() + 1,
    { message: `fiscalYear must be an integer between 2000 and ${new Date().getFullYear() + 1}` },
  ),
  framework: z.enum(['ifrs_smes', 'full_ifrs']),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const docParse = UUID.safeParse(req.query.documentId);
  const sectParse = UUID.safeParse(req.query.sectionId);
  if (!docParse.success || !sectParse.success) {
    return apiResponse.badRequest(res, 'documentId and sectionId must be valid UUIDs');
  }
  const documentId = docParse.data;
  const sectionId = sectParse.data;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { fiscalYear, framework } = parsed.data;

  log.info('Regenerating AFS section', { companyId, documentId, sectionId }, 'afs/regenerate');

  await generateSection(companyId, documentId, sectionId, fiscalYear, framework);

  return apiResponse.success(res, { sectionId });
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
