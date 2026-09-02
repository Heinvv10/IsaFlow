/**
 * Shared shape for the bank-rule tools: the enums, the reply projection, and
 * the ownership check for the three ids a rule can point at.
 *
 * Reads live in `bankRules.ts` and writes in `writeBankRules.ts` (300-line
 * cap); both must agree on the projection, because an agent that lists rules
 * and then updates one is comparing the two replies field by field.
 */
import {
  getRules,
} from '@/modules/accounting/services/bank/bankRulesService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  supplierBelongsToCompany,
  customerBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import type {
  BankCategorisationRule,
  RuleMatchField,
  RuleMatchType,
  RuleVatCode,
} from '@/modules/accounting/types/bank.types';
import { strArg } from './toolHelpers';

export const MATCH_FIELDS: readonly RuleMatchField[] = ['description', 'reference', 'both'];
export const MATCH_TYPES: readonly RuleMatchType[] = ['contains', 'starts_with', 'ends_with', 'exact'];
export const VAT_CODES: readonly RuleVatCode[] = ['none', 'standard', 'zero_rated', 'exempt'];

/**
 * Map DOWN to what an agent can act on. `is_active` and `auto_create_entry`
 * come first in intent: together they answer "will this rule post a journal
 * behind me?", which is the whole reason these tools exist.
 */
export function compactRule(rule: BankCategorisationRule): Record<string, unknown> {
  return {
    id: rule.id,
    rule_name: rule.ruleName,
    is_active: rule.isActive,
    auto_create_entry: rule.autoCreateEntry,
    match_field: rule.matchField,
    match_type: rule.matchType,
    match_pattern: rule.matchPattern,
    priority: rule.priority,
    vat_code: rule.vatCode,
    gl_account_id: rule.glAccountId ?? null,
    gl_account_code: rule.glAccountCode ?? null,
    gl_account_name: rule.glAccountName ?? null,
    supplier_id: rule.supplierId ?? null,
    supplier_name: rule.supplierName ?? null,
    client_id: rule.clientId ?? null,
    client_name: rule.clientName ?? null,
    description_template: rule.descriptionTemplate ?? null,
  };
}

/** `getRules` is already company-scoped, so this is the tenant fence too. */
export async function loadRule(
  companyId: string,
  id: string,
): Promise<BankCategorisationRule | null> {
  const rules = await getRules(companyId);
  return rules.find((r) => r.id === id) ?? null;
}

/**
 * Ownership for the three ids a rule can point at. Each becomes a foreign key
 * and neither the service nor the database re-checks the tenant, so a foreign
 * id would otherwise create a rule that posts into another company's account.
 */
export async function refsBelongToCompany(
  companyId: string,
  refs: { glAccountId?: string; supplierId?: string; clientId?: string },
): Promise<boolean> {
  if (refs.glAccountId && !(await accountsBelongToCompany(companyId, [refs.glAccountId]))) return false;
  if (refs.supplierId && !(await supplierBelongsToCompany(companyId, refs.supplierId))) return false;
  if (refs.clientId && !(await customerBelongsToCompany(companyId, refs.clientId))) return false;
  return true;
}

export const RULE_TARGET_PROPERTIES = {
  gl_account_id: { type: 'string', description: 'GL account the rule posts to' },
  supplier_id: { type: 'string' },
  client_id: { type: 'string', description: 'Customer UUID' },
  description_template: { type: 'string' },
  priority: { type: 'number', description: 'Lower runs first. Default 100.' },
  vat_code: { type: 'string', enum: [...VAT_CODES] },
  auto_create_entry: {
    type: 'boolean',
    description: 'TRUE means a match POSTS a journal automatically. Default false.',
  },
} as const;

export function parseRefs(args: Record<string, unknown>) {
  return {
    glAccountId: strArg(args, 'gl_account_id'),
    supplierId: strArg(args, 'supplier_id'),
    clientId: strArg(args, 'client_id'),
  };
}

export function parsePriority(args: Record<string, unknown>): number | undefined | 'invalid' {
  if (args.priority === undefined || args.priority === null) return undefined;
  const n = Number(args.priority);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'invalid';
  return n;
}
