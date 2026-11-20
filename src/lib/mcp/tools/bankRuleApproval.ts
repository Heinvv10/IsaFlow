/**
 * The token owner's Banking Approve on the bank-rule tools (#1656, round 5): a rule that auto-posts posts a journal per matched line,
 * so making one, editing where it posts or what it matches, or turning it back on needs Banking Approve, as a person's edit does
 * (bankRuleAutoPostApproval.ts, the same rule, run under the rule lock as a RuleWriteGuard). A dry run answers it from the rule it read.
 */
import type { McpToolContext, McpToolResult } from '../types';
import { approveRefusedMessage, mayApprove } from '@/modules/accounting/services/core/approvePermission';
import { autoPostApprovalGuard, autoPostRuleChangeNeedsApprove } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
import type { RuleProjection, RuleWriteGuard } from '@/modules/accounting/services/bank/bankRuleChangeControl';
import type { BankCategorisationRule, RuleCreateInput } from '@/modules/accounting/types/bank.types';
import { toolError } from './toolHelpers';

export const bankRuleApproveRefusal = (): McpToolResult => toolError(approveRefusedMessage('banking', 'auto-posting bank rules'));

/** The guard for a write by this token's owner, and whether they hold Banking Approve (for a dry run). */
export async function bankRuleApprovalFor(ctx: McpToolContext): Promise<{ allow: boolean; guard: RuleWriteGuard }> {
  const allow = await mayApprove(ctx.companyId, ctx.userId, 'banking');
  return { allow, guard: autoPostApprovalGuard(allow) };
}

const projectionOf = (r: BankCategorisationRule): RuleProjection => ({
  match_field: r.matchField, match_type: r.matchType, match_pattern: r.matchPattern, gl_account_id: r.glAccountId ?? null,
  supplier_id: r.supplierId ?? null, client_id: r.clientId ?? null, description_template: r.descriptionTemplate ?? null,
  vat_code: r.vatCode, auto_apply: r.autoApply, auto_create_entry: r.autoCreateEntry, is_active: r.isActive,
});

/** Would this change, to `rule` (null: a new rule), need Banking Approve? Mirrors what the guard decides under the lock. */
export function dryRunNeedsApprove(
  rule: BankCategorisationRule | null, input: Partial<RuleCreateInput> & { isActive?: boolean },
): boolean {
  const before = rule ? projectionOf(rule) : null;
  const after: RuleProjection = { ...(before ?? { is_active: true, auto_create_entry: false }) };
  const set = (k: string, v: unknown) => { if (v !== undefined && v !== null) after[k] = v; };
  set('match_field', input.matchField); set('match_type', input.matchType); set('match_pattern', input.matchPattern);
  set('gl_account_id', input.glAccountId); set('supplier_id', input.supplierId); set('client_id', input.clientId);
  set('description_template', input.descriptionTemplate); set('vat_code', input.vatCode); set('auto_apply', input.autoApply);
  set('auto_create_entry', input.autoCreateEntry); set('is_active', input.isActive);
  return autoPostRuleChangeNeedsApprove(before, after);
}
