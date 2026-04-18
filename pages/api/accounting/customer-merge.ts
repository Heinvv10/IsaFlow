/**
 * Customer Merge API
 * POST /api/accounting/customer-merge
 *
 * Re-parents all FK references from source_id → target_id within a single
 * transaction, then soft-deletes the source customer.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withTransaction } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

interface MergeBody {
  source_id: string;
  target_id: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const body = req.body as MergeBody;
  const { source_id, target_id } = body;

  if (!source_id?.trim() || !target_id?.trim()) {
    return apiResponse.badRequest(res, 'source_id and target_id are required');
  }
  if (source_id === target_id) {
    return apiResponse.badRequest(res, 'source_id and target_id must be different customers');
  }

  try {
    await withTransaction(async (tx) => {
      // 1. Validate both customers belong to this company and are active
      const customers = await tx`
        SELECT id, name
        FROM customers
        WHERE id IN (${source_id}, ${target_id})
          AND company_id = ${companyId}
          AND deleted_at IS NULL
      `;

      if ((customers as { id: string; name: string }[]).length !== 2) {
        throw new Error('One or both customers not found or do not belong to this company');
      }

      // 2. Re-parent customer_invoices
      await tx`
        UPDATE customer_invoices
        SET customer_id = ${target_id}
        WHERE customer_id = ${source_id}
          AND company_id = ${companyId}
      `;

      // 3. Re-parent customer_payments
      await tx`
        UPDATE customer_payments
        SET customer_id = ${target_id}
        WHERE customer_id = ${source_id}
          AND company_id = ${companyId}
      `;

      // 4. Re-parent customer_contacts
      await tx`
        UPDATE customer_contacts
        SET customer_id = ${target_id}
        WHERE customer_id = ${source_id}
          AND company_id = ${companyId}
      `;

      // 5. Re-parent customer_delivery_addresses
      await tx`
        UPDATE customer_delivery_addresses
        SET customer_id = ${target_id}
        WHERE customer_id = ${source_id}
          AND company_id = ${companyId}
      `;

      // 6. Re-parent customer_activities (table may not exist — swallow gracefully)
      try {
        await tx`
          UPDATE customer_activities
          SET customer_id = ${target_id}
          WHERE customer_id = ${source_id}
            AND company_id = ${companyId}
        `;
      } catch (actErr: unknown) {
        const msg = actErr instanceof Error ? actErr.message : String(actErr);
        if (!msg.includes('does not exist')) throw actErr;
        log.info('customer_activities table not found — skipping re-parent', {
          module: 'accounting',
        });
      }

      // 7. Soft-delete the source customer
      await tx`
        UPDATE customers
        SET is_active = false,
            name = name || ' [MERGED]'
        WHERE id = ${source_id}
          AND company_id = ${companyId}
      `;
    });

    log.info('Customer merge completed', {
      source_id,
      target_id,
      companyId,
      module: 'accounting',
    });

    return apiResponse.success(res, { merged: true, target_id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('customer-merge POST failed', { error: message, module: 'accounting' });

    if (message.includes('not found or do not belong')) {
      return apiResponse.badRequest(res, message);
    }
    return apiResponse.internalError(res, err, 'Failed to merge customers');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler as never)));
