/**
 * Approval Rules API
 * GET  — list all rules, and the actor's own company role (`actorRole`) so the
 *        rule form offers only roles they may demand (assertMayDemand)
 * POST — create a new rule; { action: 'starter', rules } creates a confirmed
 *        subset of the recommended set (approvalStarterService) in one savepoint
 * PUT  — update a rule
 * DELETE — delete a rule
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withSavepoint } from '@/lib/neon';
import { listRules, createRule, updateRule, deleteRule, CONDITION_OPERATORS, ApprovalRoleInvalidError, ApprovalOperatorInvalidError, ApprovalFieldInvalidError } from '@/modules/accounting/services/gl/approvalService';
import { ApprovalRuleNotFoundError } from '@/modules/accounting/services/gl/approvalAuthority';
import { ApprovalRuleAuthorityError, type RuleActor } from '@/modules/accounting/services/gl/approvalRuleGuards';
import { ApprovalRuleLegacyTypeError } from '@/modules/accounting/services/gl/approvalDocumentTypes';
import { isUuidParam } from '@/lib/validation';
import { createStarterRules, parseStarterPicks } from '@/modules/accounting/services/gl/approvalStarterService';

const OPERATOR_ERROR = `conditionOperator must be one of: ${CONDITION_OPERATORS.join(', ')}`;

/**
 * Migration 647's CHECK is NOT VALID, which Postgres still enforces on any row
 * it UPDATES, and `updateRule` re-presents the stored operator through COALESCE.
 * A legacy row carrying an unreadable operator can therefore refuse an edit that
 * never touched that column. The constraint is scoped to active rules so
 * deactivating one always works, but a 23514 from any other edit of such a row
 * belongs to the caller, not to the server.
 */
function isConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23514';
}

/**
 * `approval_requests.rule_id` references the rule with no ON DELETE action, so
 * deleting a rule that has ever been used is a 23503. That fell through to a 500
 * whose body carried the raw Postgres message — table and constraint names — for
 * an ordinary user action.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503';
}

/**
 * Every mutation maps the same outcomes. The service is the one place that
 * validates, so the route only has to translate.
 *
 * `onDelete` gates the foreign-key arm alone: 23503 on a DELETE is the rule
 * being in use, but the same code on a CREATE or an UPDATE is a different
 * violation entirely (`company_id`, say), and answering it with "this rule has
 * approval requests recorded against it and cannot be deleted" told the caller
 * about an operation they did not perform.
 */
function respondToRuleWriteError(res: NextApiResponse, error: unknown, onDelete = false): boolean {
  if (error instanceof ApprovalRoleInvalidError || error instanceof ApprovalOperatorInvalidError
      || error instanceof ApprovalFieldInvalidError || error instanceof ApprovalRuleLegacyTypeError) {
    apiResponse.badRequest(res, error.message);
    return true;
  }
  if (error instanceof ApprovalRuleAuthorityError) {
    // `reason` keeps carrying the code existing callers match on; which of the
    // two refusals it was travels beside it.
    apiResponse.error(res, ErrorCode.FORBIDDEN, error.message, { reason: error.code, authorityReason: error.reason });
    return true;
  }
  if (error instanceof ApprovalRuleNotFoundError) {
    apiResponse.notFound(res, error.message);
    return true;
  }
  if (onDelete && isForeignKeyViolation(error)) {
    apiResponse.badRequest(res, 'This rule has approval requests recorded against it and cannot be deleted. Deactivate it instead.');
    return true;
  }
  if (isConstraintViolation(error)) {
    apiResponse.badRequest(res, `${OPERATOR_ERROR}. This rule was saved with an operator that is no longer accepted; deactivate it or set a valid operator.`);
    return true;
  }
  return false;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  // Role and identity come from withAuth's company_users lookup, never the body.
  const actor: RuleActor = { userId: user.id, role: companyRole, email: user.email };

  if (req.method === 'GET') {
    const rules = await listRules(companyId);
    // The role withAuth resolved — the one every guard ranks — never the client's copy.
    return apiResponse.success(res, { items: rules, actorRole: companyRole });
  }

  if (req.method === 'POST' && typeof req.body === 'object' && req.body !== null && req.body.action === 'starter') {
    // Validated in full before any write: a 400 here has written nothing.
    const parsed = parseStarterPicks(req.body.rules);
    if (!parsed.ok) return apiResponse.badRequest(res, parsed.message);
    try {
      // ONE savepoint: a refusal on any row (createRule's assertMayDemand, say)
      // unwinds every row created before it, so the 4xx withAuth commits has
      // written nothing. All of the confirmed rules, or none.
      const result = await withSavepoint('approval_rule_starter', () => createStarterRules(companyId, parsed.picks, actor));
      return apiResponse.success(res, result);
    } catch (error) {
      if (respondToRuleWriteError(res, error)) return;
      throw error;
    }
  }

  if (req.method === 'POST') {
    const { name, documentType, conditionField, conditionOperator, conditionValue, approverRole } = req.body;
    if (!name || !documentType) {
      return apiResponse.badRequest(res, 'name and documentType are required');
    }
    try {
      // Savepoint: a rejected operator is a 23514 that has already aborted the
      // withAuth transaction, and withAuth COMMITs anything below a 500. Nothing
      // is lost today because each branch runs one statement, but a write added
      // above this line would be discarded while the response spoke only about
      // the operator.
      const rule = await withSavepoint('approval_rule_write', () => createRule(companyId, {
        name, documentType, conditionField, conditionOperator, conditionValue, approverRole,
      }, actor));
      return apiResponse.success(res, rule);
    } catch (error) {
      if (respondToRuleWriteError(res, error)) return;
      throw error;
    }
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    // Cast `::UUID` downstream: unchecked, a malformed id is a 22P02 raised
    // inside the transaction — a 500 and a logged stack for a bad request.
    if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a UUID');
    try {
      const rule = await withSavepoint('approval_rule_write', () => updateRule(companyId, id, updates, actor));
      return apiResponse.success(res, rule);
    } catch (error) {
      if (respondToRuleWriteError(res, error)) return;
      throw error;
    }
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string || req.body.id;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a UUID');
    try {
      const deleted = await withSavepoint('approval_rule_write', () => deleteRule(companyId, id, actor));
      // An id naming nothing this company owns used to answer `{ deleted: true }`.
      if (!deleted) return apiResponse.notFound(res, `Approval rule ${id} not found for this company`);
      return apiResponse.success(res, { deleted: true });
    } catch (error) {
      if (respondToRuleWriteError(res, error, true)) return;
      throw error;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
