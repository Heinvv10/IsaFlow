/**
 * A refusal from the rule definers (migration 881) back as the TypeScript
 * error the same check raises, so a route answers the same status and message
 * whichever side refused. The TypeScript checks run first; the SQL ones decide
 * only what changed in between (a rule raised under the lock) or a caller that
 * skipped them. RB020 (a forged actor or company) and RA008 (the route's role
 * gate) are not mapped: the app never sends one, so they stay a 500.
 */
import { sqlRefusal } from './approvalRuleWrites';
import { ApprovalRuleAuthorityError } from './approvalRuleGuards';
import { ApprovalRuleLegacyTypeError } from './approvalDocumentTypes';
import {
  ApprovalAmountInvalidError, ApprovalDocumentTypeInvalidError, ApprovalFieldInvalidError, ApprovalNameInvalidError,
  ApprovalOperatorInvalidError, ApprovalRoleInvalidError,
} from './approvalRuleInput';

const RULE_CODES = ['RB001', 'RB002', 'RB003', 'RB004', 'RB005', 'RB006', 'RB007', 'RB008', 'RB009'] as const;

/** The TypeScript error for a rule-definer refusal, or null when `error` is not one. */
export function ruleRefusal(error: unknown): Error | null {
  const refusal = sqlRefusal(error, RULE_CODES);
  if (!refusal) return null;
  switch (refusal.code) {
    case 'RB001': return new ApprovalRuleAuthorityError(refusal.detail);
    case 'RB002': return new ApprovalRuleAuthorityError(refusal.detail, true);
    case 'RB003': return new ApprovalRuleLegacyTypeError(refusal.detail);
    case 'RB004': return new ApprovalDocumentTypeInvalidError();
    case 'RB005': return new ApprovalNameInvalidError();
    case 'RB006': return new ApprovalRoleInvalidError(refusal.detail);
    case 'RB007': return new ApprovalOperatorInvalidError(refusal.detail);
    case 'RB008': return new ApprovalFieldInvalidError(refusal.detail);
    default: return new ApprovalAmountInvalidError();
  }
}

/** Runs a rule write, re-raising a definer refusal as its TypeScript error. */
export async function withRuleRefusals<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw ruleRefusal(error) ?? error;
  }
}
