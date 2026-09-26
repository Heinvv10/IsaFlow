/**
 * Mark / unmark customer invoices or supplier bills "VAT declared outside
 * IsaFlow / historical import" (migration 705).
 *
 * POST { action: 'mark' | 'unmark', kind: 'customer' | 'supplier', invoiceIds: string[], reason }
 *   OWNER/ADMIN ONLY (gated here, same as vat-period-locks.ts's unlock).
 *   Marking removes the document(s) from the BLOCKING unposted-invoice-VAT
 *   list (vatUnpostedInvoices.ts) and shows them instead in the non-blocking
 *   "declared elsewhere" list. Never posts to the GL, never changes a
 *   VAT201 field. Unmarking restores the block.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth, withRole, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  markVatDeclaredElsewhereBulk, unmarkVatDeclaredElsewhere,
  VatDeclaredElsewhereForbiddenError, VatDeclaredElsewhereRefusal,
} from '@/modules/accounting/services/reports/vatDeclaredElsewhereService';

const BodySchema = z.object({
  action: z.enum(['mark', 'unmark']),
  kind: z.enum(['customer', 'supplier']),
  invoiceIds: z.array(UUID).min(1).max(200),
  reason: z.string().trim().min(1, 'A reason is required').max(2000),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const companyRole = (req as CompanyAuthedRequest).companyRole;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  const { action, kind, invoiceIds, reason } = parsed.data;

  try {
    if (action === 'mark') {
      const results = await markVatDeclaredElsewhereBulk(companyId, kind, invoiceIds, { userId, role: companyRole }, reason);
      log.info('VAT declared elsewhere marked via API', { companyId, kind, count: results.length }, 'accounting-api');
      return apiResponse.success(res, { results });
    }
    // Unmark — one at a time; a single bulk unmark call is not needed today
    // (the UI action is per-invoice), but nothing stops adding it later.
    const results = [];
    for (const id of invoiceIds) {
      results.push(await unmarkVatDeclaredElsewhere(companyId, kind, id, { userId, role: companyRole }, reason));
    }
    log.info('VAT declared elsewhere unmarked via API', { companyId, kind, count: results.length }, 'accounting-api');
    return apiResponse.success(res, { results });
  } catch (err) {
    if (err instanceof VatDeclaredElsewhereForbiddenError) return apiResponse.forbidden(res, err.message);
    if (err instanceof VatDeclaredElsewhereRefusal) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

// Owner/admin only, at the route — same threshold as unlockVatPeriod.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(withRole('admin')(handler)))));
