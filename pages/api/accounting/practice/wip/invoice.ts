/**
 * Practice WIP Invoice Generation API
 * POST /api/accounting/practice/wip/invoice — generate invoice from WIP entries
 *
 * R-120: a refusal the operator can act on (`WipInvoiceRefusal`, or a body
 * field that fails the schema) is a 400 carrying its own message. Everything
 * else is re-thrown to withErrorHandler: a 500 that withAuth rolls back, or a
 * 503 on lock contention. Every error used to become a 400 "WIP invoice
 * failed" — the reason masked, and a fault indistinguishable from a refusal.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import {
  withAuth,
  type CompanyAuthedRequest,
  type AuthenticatedNextApiRequest,
  withWriteAccess,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { generateWipInvoice, WipInvoiceRefusal } from '@/modules/accounting/services/practice/practiceWipService';

const WipInvoiceBody = z.object({
  // UUID is z.guid(): Zod 4's .uuid() rejects seeded, non-RFC-version ids.
  practiceClientId: UUID,
  timeEntryIds: z.array(UUID).min(1),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Range (0-100) is the service's rule, assertWipTaxRate: one place, one message.
  taxRate: z.number().finite().optional(),
  groupBy: z.enum(['detailed', 'by_work_item', 'by_category']).optional(),
});

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const parsed = WipInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return apiResponse.badRequest(res, `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  try {
    const result = await generateWipInvoice(companyId, req.user.id, parsed.data);
    return apiResponse.created(res, result);
  } catch (err) {
    if (err instanceof WipInvoiceRefusal) {
      log.warn('WIP invoice refused', { companyId, reason: err.message }, 'practice-api');
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
