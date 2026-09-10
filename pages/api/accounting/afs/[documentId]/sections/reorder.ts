// pages/api/accounting/afs/[documentId]/sections/reorder.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID, requireUuidParam } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sendReviewError } from '@/modules/accounting/services/afs/afsReviewErrorResponse';
import { lockSectionForWrite } from '@/modules/accounting/services/afs/afsSectionAttestation';
import { sql } from '@/lib/neon';

const ReorderItemSchema = z.object({
  id: UUID,
  newSortOrder: z.number().int().positive(),
}).strict();

const BodySchema = z.object({
  sections: z.array(ReorderItemSchema).min(1).max(50),
}).strict().refine(
  v => new Set(v.sections.map(s => s.newSortOrder)).size === v.sections.length,
  { message: 'Duplicate newSortOrder values are not allowed', path: ['sections'] },
);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);

  const { companyId } = req as CompanyAuthedRequest;
  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { sections } = parsed.data;

  // Note order is note numbering: it goes through the same guard as any other section write.
  // Every section is locked FIRST, in id order, so a document that refuses one refuses all of
  // them and no partial renumbering is left behind by a 4xx (which commits the request).
  try {
    for (const { id } of [...sections].sort((a, b) => a.id.localeCompare(b.id))) {
      await lockSectionForWrite(companyId, documentId, id);
    }
  } catch (err) {
    if (sendReviewError(res, err, 'Section', documentId)) return;
    throw err;
  }

  for (const { id, newSortOrder } of sections) {
    await sql`
      UPDATE afs_sections
      SET sort_order  = ${newSortOrder},
          updated_at  = NOW()
      WHERE id          = ${id}::UUID
        AND document_id = ${documentId}::UUID
        AND company_id  = ${companyId}::UUID
    `;
  }

  log.info('Reordered AFS sections', { companyId, documentId, count: sections.length }, 'afs-sections-reorder-api');

  return apiResponse.success(res, { reordered: sections.length });
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
