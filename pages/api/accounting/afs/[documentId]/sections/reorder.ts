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
import { lockSectionForWrite, voidSectionAttestation } from '@/modules/accounting/services/afs/afsSectionAttestation';
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

  const companyReq = req as CompanyAuthedRequest;
  const { companyId } = companyReq;
  const documentId = requireUuidParam(req, res, 'documentId');
  if (!documentId) return;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { sections } = parsed.data;

  // Note order is note numbering — the number the statements print and the notes cross-refer
  // to — so a reorder goes through the same guard as any other section write, and voids the
  // review of every section whose number changes.
  //
  // The payload must renumber the WHOLE document: a partial one leaves two notes sharing a
  // number. Ids are compared lowercased (the schema accepts either case) so two clients
  // sending the same sections in different case take the row locks in the same order and
  // cannot deadlock against each other.
  const requested = sections.map(s => ({ ...s, key: s.id.toLowerCase() }));
  const existing = (await sql`
    SELECT id, sort_order FROM afs_sections
    WHERE document_id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  `) as Array<{ id: string; sort_order: number }>;
  const current = new Map(existing.map(row => [row.id.toLowerCase(), Number(row.sort_order)]));
  if (requested.length !== current.size) {
    return apiResponse.badRequest(
      res,
      `Reorder must renumber every section of the document: ${current.size} section(s) exist, ${requested.length} supplied`,
    );
  }

  const ordered = [...requested].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const locked = [];
  try {
    for (const { id, key } of ordered) {
      if (!current.has(key)) return apiResponse.notFound(res, 'AFS section', id);
      locked.push(await lockSectionForWrite(companyId, documentId, id));
    }
  } catch (err) {
    if (sendReviewError(res, err, 'AFS section', documentId)) return;
    throw err;
  }

  const changed = new Set(requested.filter(s => current.get(s.key) !== s.newSortOrder).map(s => s.key));
  try {
    for (const section of locked) {
      if (changed.has(section.id.toLowerCase())) {
        await voidSectionAttestation(companyId, section, companyReq.user.id, 'Section renumbered by a reorder');
      }
    }
  } catch (err) {
    if (sendReviewError(res, err, 'AFS section', documentId)) return;
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
