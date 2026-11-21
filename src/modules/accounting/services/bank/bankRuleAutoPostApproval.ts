/**
 * Who may change what an AUTO-POSTING bank rule posts (#1656, round 5 and 6): a rule that posts a journal for every line it matches (its own
 * auto_create_entry, OR company auto-post being on, which makes every active rule post: bank_rule_posts_money, migration 877) is an
 * approval act to make, to re-point, to re-prioritise, to switch on or off, and to delete, because each changes which journals get posted. The
 * test is on the rule as the write finds it under its lock (before) and as it would stand (after), with the DATABASE's own "posts money"
 * predicate for each, NOT on the request's flag: a request that leaves auto_create_entry out and edits an existing rule's account, supplier, customer,
 * match, VAT or priority still needs Banking Approve. A rule that posts neither before nor after is edited freely.
 *
 * Passed as the RuleWriteGuard of createRule / updateRule / toggleRule and the RuleDeleteGuard of deleteRule(s), so it runs under the rule
 * lock, before any write, for every caller (the app routes and the MCP tools).
 */
import { ApprovePermissionError } from '../core/approvePermission';
import type { RuleDeleteGuard, RuleProjection, RuleWriteGuard } from './bankRuleChangeControl';

/** The columns that decide what a posting rule matches, where its journal goes and which rule wins; and the switches. */
export const AUTO_POST_RULE_FIELDS = [
  'match_field', 'match_type', 'match_pattern', 'gl_account_id', 'supplier_id', 'client_id', 'description_template',
  'vat_code', 'auto_apply', 'auto_create_entry', 'priority', 'is_active',
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Does this write need Banking Approve? `before` is null for a creation; `postsBefore` / `postsAfter` are bank_rule_posts_money. */
export function autoPostRuleChangeNeedsApprove(
  before: RuleProjection | null, after: RuleProjection, postsAfter: boolean, postsBefore: boolean,
): boolean {
  const postsTo = postsAfter || after.auto_create_entry === true;
  if (before === null) return postsTo && after.is_active !== false; // a new rule that would post
  const postsFrom = postsBefore || before.auto_create_entry === true;
  if (!postsTo && !postsFrom) return false;
  return AUTO_POST_RULE_FIELDS.some((f) => !same(before[f], after[f]));
}

/** The guard: allowed with Banking Approve; otherwise a write that needs it throws ApprovePermissionError (403). */
export function autoPostApprovalGuard(mayApproveBanking: boolean): RuleWriteGuard {
  return (after, postsMoney, before, beforePostsMoney) => {
    if (mayApproveBanking) return;
    if (autoPostRuleChangeNeedsApprove(before ?? null, after, postsMoney, beforePostsMoney === true)) {
      throw new ApprovePermissionError('banking', 'auto-posting bank rules');
    }
  };
}

/** Deleting a rule that posts (or would, with company auto-post on) changes which journals get posted: Banking Approve. */
export function autoPostDeleteGuard(mayApproveBanking: boolean): RuleDeleteGuard {
  return (rows) => {
    if (mayApproveBanking) return;
    if (rows.some((r) => r.postsMoney || r.before.auto_create_entry === true)) throw new ApprovePermissionError('banking', 'auto-posting bank rules');
  };
}

/** Run each guard in order (the MCP tools add their token-scope guard to this one). */
export function allGuards(...guards: RuleWriteGuard[]): RuleWriteGuard {
  return async (after, postsMoney, before, beforePostsMoney) => { for (const g of guards) await g(after, postsMoney, before, beforePostsMoney); };
}
