/**
 * Supplier Invoice Actions API
 * POST /api/accounting/supplier-invoices-action
 *   action: approve | cancel | match
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  approveSupplierInvoice,
  cancelSupplierInvoice,
  performThreeWayMatch,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { respondIfBudgetRefused } from '@/lib/budgetCheckResponse';
import { BUDGET_REASON_MAX } from '@/modules/accounting/services/budgets/budgetCheckTypes';
// TODO(PRD-05): When a human-driven CREATE path is added to this handler
// (or to pages/api/accounting/supplier-invoices.ts), call:
//   recordCoding({ companyId, supplierId, supplierInvoiceId, glAccountId, vatCode,
//                  costCentreId, projectId, postedBy: `human:${userId}` })
// and stamp duplicate_fingerprint on the INSERT using computeFingerprint().
// import { recordCoding } from '@/modules/accounting/services/capture/supplierRulesService';
// import { computeFingerprint } from '@/modules/accounting/services/capture/captureDeduplicationService';

const SupplierInvoiceActionSchema = z.discriminatedUnion('action', [
  // Budgets P5-2: the reason for approving over budget (warn), or for an owner/admin override (block).
  z.object({
    action: z.literal('approve'), invoiceId: UUID,
    budgetReason: z.string().trim().max(BUDGET_REASON_MAX).optional(),
    budgetOverride: z.boolean().optional(),
  }),
  z.object({ action: z.literal('cancel'), invoiceId: UUID }),
  z.object({ action: z.literal('match'), invoiceId: UUID }),
]);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const parsed = SupplierInvoiceActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }

  try {
    const { action, invoiceId } = parsed.data;
    const userId = req.user.id;

    switch (action) {
      case 'approve': {
        // A person approving: a bill dated in a filed VAT period claims its input
        // VAT late (s16(3)) where the law allows, and `lateClaim` says so.
        // Budget check (P5-2): channel ui, the company budget lock taken inside approve, first.
        const { budgetReason, budgetOverride } = parsed.data;
        const budget = {
          channel: 'ui' as const, lock: 'take' as const, reason: budgetReason ?? null, override: budgetOverride === true,
          actorRole: (req as CompanyAuthedRequest).companyRole,
        };
        const invoice = await withJournalDateRefusal(res, () =>
          approveSupplierInvoice(companyId, invoiceId, userId, { allowLateInputClaim: true, budget }));
        if (invoice === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, invoice);
      }
      case 'cancel': {
        const invoice = await withJournalDateRefusal(res, () => cancelSupplierInvoice(companyId, invoiceId, userId));
        if (invoice === JOURNAL_DATE_REFUSED) return;
        return apiResponse.success(res, invoice);
      }
      case 'match': {
        const result = await performThreeWayMatch(companyId, invoiceId);
        return apiResponse.success(res, result);
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    // R-035: a 409 the client acts on (submit for approval), not the blanket 400.
    if (respondIfApprovalRequired(res, err)) return;
    // P5-2: 409 BUDGET_EXCEEDED (its refused event recorded here, outside approve's savepoint) or 400 BUDGET_REASON_REQUIRED.
    if (await respondIfBudgetRefused(res, err)) return;
    // Step 2: settling a bank-first provisional the approver imported — 403 with its reason, raised before any write.
    if (respondIfBankControlRefused(res, err)) return;
    // Any row-lock timeout (D8 round 9: the reversal chain's head, a document row) is 503 + Retry-After.
    if (respondIfLockTimeout(res, err)) return;
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Supplier invoice action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
