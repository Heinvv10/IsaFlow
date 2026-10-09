/**
 * Bank Categorisation Rules API
 * GET  — list all rules
 * POST — create a new rule. Under the `bank_rule` switch a rule that would
 *        auto-post is HELD for another person's approval: the answer is
 *        { status: 'pending_approval', changeId, applied: 0 } and nothing runs.
 *        Otherwise { ...rule, status: 'applied', applied }.
 *
 * Audit: docs/codex/browser-audits/monthly-close-market-readiness-audit.md
 * Finding 4 — make rule effects explicit, default to suggest-only.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { AUTO_APPLY_MODES } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { getRules, createRule, applyRules } from '@/modules/accounting/services/bank/bankRulesService';
import { CustomerNotInCompanyError, SupplierNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';

const CreateRuleSchema = z.object({
  ruleName: z.string().min(1).max(200),
  matchField: z.enum(['description', 'reference', 'both']),
  matchType: z.enum(['contains', 'starts_with', 'ends_with', 'exact']),
  matchPattern: z.string().min(1).max(500),
  glAccountId: UUID.optional().nullable(),
  supplierId: UUID.optional().nullable(),
  clientId: UUID.optional().nullable(),
  descriptionTemplate: z.string().max(500).optional().nullable(),
  priority: z.number().int().optional(),
  // Suggest-only by default. The UI must opt in to auto-posting because that
  // creates and posts a journal entry on every match.
  autoCreateEntry: z.boolean().optional().default(false),
  vatCode: z.enum(['none', 'standard', 'zero_rated', 'exempt']).optional().default('none'),
  // What an auto-posted supplier/customer line does with its cash. Only
  // meaningful alongside autoCreateEntry — see migration 676.
  autoApply: z.enum(AUTO_APPLY_MODES).optional(),
  bankAccountId: UUID.optional().nullable(),
}).refine(
  v => Boolean(v.glAccountId) || Boolean(v.supplierId) || Boolean(v.clientId),
  { message: 'glAccountId, supplierId, or clientId is required' },
);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const rules = await getRules(companyId);
    return apiResponse.success(res, { items: rules });
  }

  if (req.method === 'POST') {
    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const input = parsed.data;
    let rule;
    try {
      rule = await createRule(companyId, {
        ruleName: input.ruleName,
        matchField: input.matchField,
        matchType: input.matchType,
        matchPattern: input.matchPattern,
        glAccountId: input.glAccountId || undefined,
        supplierId: input.supplierId || undefined,
        clientId: input.clientId || undefined,
        descriptionTemplate: input.descriptionTemplate || undefined,
        priority: input.priority ?? 100,
        autoCreateEntry: input.autoCreateEntry,
        vatCode: input.vatCode,
        // Omitted rather than defaulted here: the service and the column own
        // the default, and a second copy of it is how two entry points drift.
        ...(input.autoApply === undefined ? {} : { autoApply: input.autoApply }),
      }, userId);
    } catch (err) {
      // Refused before the INSERT, so nothing has been written.
      if (err instanceof CustomerNotInCompanyError || err instanceof SupplierNotInCompanyError) {
        return apiResponse.badRequest(res, err.message);
      }
      throw err;
    }

    // Held for approval (the `bank_rule` switch): no rule exists yet, so
    // nothing runs — a creation awaiting approval never posts on the spot.
    if (rule.status === 'pending_approval') return apiResponse.success(res, { ...rule, applied: 0 });

    // Auto-apply on create: run only the new rule so the returned `applied`
    // count reflects this rule's matches and not the entire ruleset.
    let applied = 0;
    if (input.bankAccountId) {
      const result = await applyRules(companyId, input.bankAccountId, userId, [rule.id]);
      applied = result.applied;
    }

    return apiResponse.success(res, { ...rule, applied });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
