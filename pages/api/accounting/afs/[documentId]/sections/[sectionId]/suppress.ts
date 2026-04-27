// pages/api/accounting/afs/[documentId]/sections/[sectionId]/suppress.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

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

  const { companyId } = req as CompanyAuthedRequest;
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
  const { suppress, reason } = parsed.data;

  // Step 1 — Check current status
  const rows = (await sql`
    SELECT s.status
    FROM afs_sections s
    WHERE s.id = ${sectionId}::UUID
      AND s.document_id IN (
        SELECT id FROM afs_documents WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
      )
    LIMIT 1
  `) as DbRow[];

  if (rows.length === 0) {
    return apiResponse.notFound(res, 'Section not found');
  }

  const section = rows[0] as DbRow;
  if (section['status'] === 'signed_off') {
    return apiResponse.badRequest(res, 'Cannot suppress a signed-off section');
  }

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
