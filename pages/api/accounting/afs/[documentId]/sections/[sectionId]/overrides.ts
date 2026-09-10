// pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { requireUuidParam } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { ReviewError } from '@/modules/accounting/services/afs/afsReviewService';
import {
  lockSectionForWrite,
  voidSectionAttestation,
  type LockedSection,
} from '@/modules/accounting/services/afs/afsSectionAttestation';
import { saveVersion } from '@/modules/accounting/services/afs/afsVersionHistoryService';

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
  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;
  const sectionId = requireUuidParam(req, res, 'sectionId');
  if (!sectionId) return;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { overrides } = parsed.data;

  log.info('Section overrides update', { companyId, documentId, sectionId, userId }, 'afs-overrides-api');

  // Bound to the URL's document, refused while it is locked, and held until commit.
  let section: LockedSection;
  try {
    section = await lockSectionForWrite(companyId, documentId, sectionId);
  } catch (err) {
    if (err instanceof ReviewError) {
      if (err.code === 'NOT_FOUND') return apiResponse.notFound(res, 'Section', sectionId);
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message);
    }
    throw err;
  }

  // New overrides are new content: whatever review covered the old content no longer does.
  await voidSectionAttestation(companyId, section, userId, 'Section overrides changed');
  // Save version snapshot BEFORE applying overrides
  const versionEntry = await saveVersion(companyId, documentId, sectionId, userId);

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
