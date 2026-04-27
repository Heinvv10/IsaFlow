/**
 * Supplier Merge API
 * POST /api/accounting/supplier-merge
 *
 * Re-parents all FK references from source_id → target_id within a single
 * transaction, then soft-deletes the source supplier.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withTransaction } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

const MergeBodySchema = z.object({
  source_id: UUID,
  target_id: UUID,
}).strict().refine(v => v.source_id !== v.target_id, {
  message: 'source_id and target_id must be different suppliers',
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const parsed = MergeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { source_id, target_id } = parsed.data;

  try {
    await withTransaction(async (tx) => {
      // 1. Validate both suppliers belong to this company and are active
      const suppliers = await tx`
        SELECT id, name
        FROM suppliers
        WHERE id IN (${source_id}, ${target_id})
          AND company_id = ${companyId}
          AND deleted_at IS NULL
      `;

      if ((suppliers as { id: string; name: string }[]).length !== 2) {
        throw new Error('One or both suppliers not found or do not belong to this company');
      }

      // 2. Re-parent supplier_invoices
      await tx`
        UPDATE supplier_invoices
        SET supplier_id = ${target_id}
        WHERE supplier_id = ${source_id}
          AND company_id = ${companyId}
      `;

      // 3. Re-parent supplier_payments
      await tx`
        UPDATE supplier_payments
        SET supplier_id = ${target_id}
        WHERE supplier_id = ${source_id}
          AND company_id = ${companyId}
      `;

      // 4. Re-parent supplier_purchase_orders
      await tx`
        UPDATE supplier_purchase_orders
        SET supplier_id = ${target_id}
        WHERE supplier_id = ${source_id}
          AND company_id = ${companyId}
      `;

      // Note: unified credit_notes table covers both customer and supplier
      // credit notes; no separate supplier_credit_notes table exists.

      // 6. Soft-delete the source supplier
      await tx`
        UPDATE suppliers
        SET is_active = false,
            name = name || ' [MERGED]'
        WHERE id = ${source_id}
          AND company_id = ${companyId}
      `;
    });

    log.info('Supplier merge completed', {
      source_id,
      target_id,
      companyId,
      module: 'accounting',
    });

    return apiResponse.success(res, { merged: true, target_id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('supplier-merge POST failed', { error: message, module: 'accounting' });

    if (message.includes('not found or do not belong')) {
      return apiResponse.badRequest(res, message);
    }
    return apiResponse.internalError(res, err, 'Failed to merge suppliers');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
