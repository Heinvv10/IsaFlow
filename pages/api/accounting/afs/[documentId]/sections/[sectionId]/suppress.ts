// pages/api/accounting/afs/[documentId]/sections/[sectionId]/suppress.ts
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

const BodySchema = z.object({
  suppress: z.boolean(),
  reason: z.string().trim().max(2000).optional(),
}).strict().refine(
  // `reason` is already trimmed by the field schema, so an empty/whitespace
  // input arrives here as ''. Falsy check covers both undefined and ''.
  v => !(v.suppress && !v.reason),
  { message: 'reason is required when suppressing a section', path: ['reason'] },
);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;
  const sectionId = requireUuidParam(req, res, 'sectionId');
  if (!sectionId) return;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { suppress, reason } = parsed.data;

  // Step 1 — Lock the section of this document; a signed-off or filed document takes no write
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

  if (section.status === 'signed_off') {
    return apiResponse.badRequest(res, 'Cannot suppress a signed-off section');
  }

  // Suppressing or restoring a note changes what the statements show: the review is void.
  await voidSectionAttestation(companyId, section, companyReq.user.id,
    suppress ? 'Section suppressed' : 'Section suppression removed');

  // Step 2 — Apply or remove suppression
  if (suppress) {
    await sql`
      UPDATE afs_sections
      SET data_snapshot = jsonb_set(
            COALESCE(data_snapshot, '{}'::JSONB),
            '{suppressReason}',
            ${JSON.stringify(reason)}::JSONB
          ),
          status = 'pending',
          updated_at = NOW()
      WHERE id = ${sectionId}::UUID
        AND document_id IN (
          SELECT id FROM afs_documents WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
        )
    `;
  } else {
    await sql`
      UPDATE afs_sections
      SET data_snapshot = data_snapshot - 'suppressReason',
          status = 'pending',
          updated_at = NOW()
      WHERE id = ${sectionId}::UUID
        AND document_id IN (
          SELECT id FROM afs_documents WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
        )
    `;
  }

  log.info(
    suppress ? 'AFS section suppressed' : 'AFS section unsuppressed',
    { companyId, documentId, sectionId, suppress, reason },
    'afs-suppress-api',
  );

  return apiResponse.success(res, { suppressed: suppress });
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
