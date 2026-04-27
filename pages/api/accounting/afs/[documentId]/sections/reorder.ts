// pages/api/accounting/afs/[documentId]/sections/reorder.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT']);

  const { companyId } = req as CompanyAuthedRequest;
  const { documentId } = req.query as { documentId: string };
  const { sections } = req.body as { sections?: unknown };

  if (!Array.isArray(sections) || sections.length === 0) {
    return apiResponse.badRequest(res, 'sections must be a non-empty array');
  }

  if (sections.length > 50) {
    return apiResponse.badRequest(res, 'Cannot reorder more than 50 sections at once');
  }

  const items = sections as Array<{ id?: unknown; newSortOrder?: unknown }>;
  const valid = items.every(
    item =>
      typeof item.id === 'string' &&
      typeof item.newSortOrder === 'number' &&
      Number.isInteger(item.newSortOrder) &&
      item.newSortOrder > 0,
  );
  if (!valid) return apiResponse.badRequest(res, 'Each item must have a string id and positive integer newSortOrder');

  const orders = (sections as Array<{ newSortOrder: number }>).map(r => r.newSortOrder);
  if (new Set(orders).size !== orders.length) {
    return apiResponse.badRequest(res, 'Duplicate newSortOrder values are not allowed');
  }

  const typedItems = sections as Array<{ id: string; newSortOrder: number }>;
  await Promise.all(
    typedItems.map(({ id, newSortOrder }) =>
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

  log.info('Reordered AFS sections', { companyId, documentId, count: typedItems.length }, 'afs-sections-reorder-api');

  return apiResponse.success(res, { reordered: typedItems.length });
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
