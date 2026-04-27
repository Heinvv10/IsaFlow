// pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  assertDocumentEditable,
  ReviewError,
} from '@/modules/accounting/services/afs/afsReviewService';
import {
  saveVersion,
  VersionHistoryError,
} from '@/modules/accounting/services/afs/afsVersionHistoryService';

// `overrides` is a free-form JSONB blob (per-tenant section overrides).
// Validate it's a JSON object; the structure varies by note generator.
const BodySchema = z.object({
  overrides: z.record(z.string(), z.unknown()),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);
  }

  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const userId = companyReq.user.id;
  const docParse = UUID.safeParse(req.query.documentId);
  const sectParse = UUID.safeParse(req.query.sectionId);
  if (!docParse.success || !sectParse.success) {
    return apiResponse.badRequest(res, 'documentId and sectionId must be valid UUIDs');
  }
  const documentId = docParse.data;
  const sectionId = sectParse.data;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(
      res,
      parsed.error.flatten().fieldErrors as Record<string, string | string[]>,
    );
  }
  const { overrides } = parsed.data;

  log.info('Section overrides update', { companyId, documentId, sectionId, userId }, 'afs-overrides-api');

  try {
    await assertDocumentEditable(companyId, documentId);
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'AFS document', documentId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }

  // Save version snapshot BEFORE applying overrides
  let versionEntry;
  try {
    versionEntry = await saveVersion(companyId, sectionId, userId);
  } catch (err) {
    if (err instanceof VersionHistoryError && err.code === 'NOT_FOUND') {
      return apiResponse.notFound(res, 'Section', sectionId);
    }
    throw err;
  }

  // Apply new overrides
  await sql`
    UPDATE afs_sections
    SET overrides = ${JSON.stringify(overrides)}::jsonb,
        updated_at = now()
    WHERE id = ${sectionId}
      AND document_id = ${documentId}
      AND company_id = ${companyId}
  `;

  return apiResponse.success(res, { sectionId, version: versionEntry }, 'Overrides applied');
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
