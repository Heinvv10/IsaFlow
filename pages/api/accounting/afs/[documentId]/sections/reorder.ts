// pages/api/accounting/afs/[documentId]/sections/reorder.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
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
  const docParse = UUID.safeParse(req.query.documentId);
  if (!docParse.success) return apiResponse.badRequest(res, 'documentId must be a valid UUID');
  const documentId = docParse.data;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { sections } = parsed.data;

  await Promise.all(
    sections.map(({ id, newSortOrder }) =>
      sql`
        UPDATE afs_sections
        SET sort_order  = ${newSortOrder},
            updated_at  = NOW()
        WHERE id          = ${id}::UUID
          AND document_id = ${documentId}::UUID
          AND company_id  = ${companyId}::UUID
      `,
    ),
  );

  log.info('Reordered AFS sections', { companyId, documentId, count: sections.length }, 'afs-sections-reorder-api');

  return apiResponse.success(res, { reordered: sections.length });
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
