/**
 * Customers Bulk Actions API
 * POST /api/accounting/customers-bulk
 *
 * Body: { ids: string[], action: 'activate' | 'deactivate' | 'export' }
 *
 * activate   → SET is_active = true  for the given IDs
 * deactivate → SET is_active = false for the given IDs
 * export     → returns CSV of selected customers
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { cache } from '@/lib/cache';
import { CACHE_KEYS } from '@/lib/cache-keys';
import { escapeCsv } from '@/lib/csv';
import { EXPORT_ROW_CEILING } from '@/lib/pagination';

type BulkAction = 'activate' | 'deactivate' | 'export';

// Aligned with supplier-invoices-bulk-action.ts (z.array(UUID).min(1).max(200))
// and statement-bulk-email.ts (MAX_BATCH_SIZE = 100).
const MAX_BATCH_SIZE = 200;

interface BulkRequestBody {
  ids: string[];
  action: BulkAction;
}

export interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  payment_terms: number;
  credit_limit: number | null;
  is_active: boolean;
}

export function buildCsv(rows: CustomerRow[]): string {
  const header = ['Name', 'Email', 'Phone', 'Payment Terms (days)', 'Credit Limit', 'Active'];
  const lines: string[] = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        escapeCsv(r.name),
        escapeCsv(r.email),
        escapeCsv(r.phone),
        escapeCsv(r.payment_terms),
        escapeCsv(r.credit_limit),
        escapeCsv(r.is_active ? 'Yes' : 'No'),
      ].join(','),
    );
  }
  return lines.join('\n');
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const body = req.body as Partial<BulkRequestBody>;

  const ids = body.ids;
  const action = body.action;

  if (!Array.isArray(ids) || ids.length === 0) {
    return apiResponse.badRequest(res, 'ids must be a non-empty array');
  }

  if (ids.length > MAX_BATCH_SIZE) {
    return apiResponse.badRequest(res, `ids must not exceed ${MAX_BATCH_SIZE} items`);
  }

  if (!action || !['activate', 'deactivate', 'export'].includes(action)) {
    return apiResponse.badRequest(res, 'action must be one of: activate, deactivate, export');
  }

  // Validate all ids are valid UUIDs (basic safety guard)
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!ids.every((id) => typeof id === 'string' && uuidPattern.test(id))) {
    return apiResponse.badRequest(res, 'One or more ids are invalid');
  }

  // ─── activate / deactivate ────────────────────────────────────────────────
  if (action === 'activate' || action === 'deactivate') {
    const isActive = action === 'activate';
    try {
      const updated = (await sql`
        UPDATE customers
        SET    is_active = ${isActive},
               updated_at = NOW()
        WHERE  id        = ANY(${ids}::uuid[])
          AND  company_id = ${companyId}
          AND  deleted_at IS NULL
        RETURNING id
      `) as { id: string }[];
      cache.invalidate(CACHE_KEYS.customers(companyId));
      log.info('Customers bulk status updated', {
        action,
        count: updated.length,
        module: 'accounting',
      });
      return apiResponse.success(res, { updated: updated.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customers-bulk UPDATE failed', { error: message, action, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to update customers');
    }
  }

  // ─── export ───────────────────────────────────────────────────────────────
  try {
    const rows = (await sql`
      SELECT
        id, name, email, phone,
        payment_terms, credit_limit, is_active
      FROM customers
      WHERE id        = ANY(${ids}::uuid[])
        AND company_id = ${companyId}
        AND deleted_at IS NULL
      ORDER BY name ASC
      LIMIT ${EXPORT_ROW_CEILING}
    `) as CustomerRow[];

    const csv = buildCsv(rows);
    log.info('Customers bulk export', { count: rows.length, module: 'accounting' });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="customers-export.csv"');
    res.status(200).end(csv);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('customers-bulk EXPORT failed', { error: message, module: 'accounting' });
    return apiResponse.internalError(res, err, 'Failed to export customers');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
