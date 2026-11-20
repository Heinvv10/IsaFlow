/**
 * Who may change what an AUTO-POSTING bank rule posts (#1656, round 5): a rule with auto_create_entry posts a journal for every line
 * it matches, so editing where it posts or what it matches, or turning it back on, is an approval act, as is making one. The test is
 * on the rule as the write finds it (locked, before) and as it would stand (after), NOT on the request's own flag: a request that
 * leaves auto_create_entry out and edits an existing auto-posting rule's account, supplier, customer, match or VAT still needs
 * Banking Approve (the old route gate looked only at body.autoCreateEntry === true).
 *
 * Passed as the RuleWriteGuard of createRule / updateRule / toggleRule, so it runs under the rule lock, before any write, for every
 * caller (the app routes and the MCP tools). A priority-only or name-only edit of an auto-post rule, and any edit of a rule that
 * does not auto-post, needs nothing.
 */
import { ApprovePermissionError } from '../core/approvePermission';
import type { RuleProjection, RuleWriteGuard } from './bankRuleChangeControl';

/** The columns that decide what an auto-posting rule matches and where its journal goes (and the switch itself). */
export const AUTO_POST_RULE_FIELDS = [
  'match_field', 'match_type', 'match_pattern', 'gl_account_id', 'supplier_id', 'client_id', 'description_template',
  'vat_code', 'auto_apply', 'auto_create_entry',
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Does this write need Banking Approve? `before` is null for a creation. */
export function autoPostRuleChangeNeedsApprove(before: RuleProjection | null, after: RuleProjection): boolean {
  if (after.auto_create_entry !== true) return false; // willAutoPost: the flag as it would stand
  if (before === null) return after.is_active !== false; // a new auto-posting rule
  const activates = after.is_active === true && before.is_active !== true;
  return activates || AUTO_POST_RULE_FIELDS.some((f) => !same(before[f], after[f]));
}

/** The guard: allowed when the person has Banking Approve; otherwise a write that needs it throws ApprovePermissionError (403). */
export function autoPostApprovalGuard(mayApproveBanking: boolean): RuleWriteGuard {
  return (after, _postsMoney, before) => {
    if (mayApproveBanking) return;
    if (autoPostRuleChangeNeedsApprove(before ?? null, after)) throw new ApprovePermissionError('banking', 'auto-posting bank rules');
  };
}

/** Run each guard in order (the MCP tools add their token-scope guard to this one). */
export function allGuards(...guards: RuleWriteGuard[]): RuleWriteGuard {
  return async (after, postsMoney, before) => { for (const g of guards) await g(after, postsMoney, before); };
}
