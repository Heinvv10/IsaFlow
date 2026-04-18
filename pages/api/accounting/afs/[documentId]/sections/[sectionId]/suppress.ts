// pages/api/accounting/afs/[documentId]/sections/[sectionId]/suppress.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { documentId, sectionId } = req.query as { documentId: string; sectionId: string };
  const { suppress, reason } = req.body as { suppress?: unknown; reason?: unknown };

  if (typeof suppress !== 'boolean') {
    return apiResponse.badRequest(res, 'suppress must be a boolean');
  }
  if (suppress && (typeof reason !== 'string' || reason.trim() === '')) {
    return apiResponse.badRequest(res, 'reason is required when suppressing a section');
  }

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
            ${JSON.stringify(reason as string)}::JSONB
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

export default withAuth(withErrorHandler(handler as never));
