/**
 * Bank-rule changes (forensic-controls step 2; Hein's decision 3)
 * GET  — the company's rule changes, newest first: `?status=pending` (default)
 *        or `all`; `?ruleId=` for one rule's history. Each with its rule's
 *        name, kind, before/after and the keys that move, proposer, status,
 *        decider, the digest a decision must name, and `canDecide` — whether
 *        this viewer may decide it now (a hint; the POST decides).
 * POST — { action: 'approve' | 'reject', changeId, digest, note? } decides a
 *        change held under the `bank_rule` switch; an approval applies it.
 *        Refused (bankControlRefusal, nothing written): 403 login-as, an
 *        agent, a role below the approver role, the proposer (unless the sole
 *        approver); 404 not this company's; 409 not pending, wrong digest, or
 *        the rule changed since it was proposed. There is no MCP equivalent:
 *        agents may propose a change, never decide one.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withSavepoint } from '@/lib/neon';
import { UUID } from '@/lib/schemas/common';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { decideHint } from '@/modules/accounting/services/bank/bankRuleApprovers';
import { decideRuleChange } from '@/modules/accounting/services/bank/bankRuleChangeDecision';
import { listRuleChanges } from '@/modules/accounting/services/bank/bankRuleChangeQueries';

const ListQuery = z.object({ status: z.enum(['pending', 'all']).default('pending'), ruleId: UUID.optional() });
const DecideBody = z.object({
  action: z.enum(['approve', 'reject']),
  changeId: UUID,
  digest: z.string().min(1).max(128),
  note: z.string().max(500).optional().nullable(),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    const changes = await listRuleChanges(companyId, parsed.data);
    const mayDecide = await decideHint(companyId, user.id);
    const items = changes.map((c) => ({ ...c, canDecide: c.status === 'pending' && mayDecide(c.proposedBy) }));
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const parsed = DecideBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    const { action, changeId, digest, note } = parsed.data;
    try {
      const result = await withSavepoint('bank_rule_change_decide', () =>
        decideRuleChange(companyId, changeId, { decision: action, digest, note }, { userId: user.id }));
      return apiResponse.success(res, result);
    } catch (err) {
      if (respondIfBankControlRefused(res, err)) return;
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
