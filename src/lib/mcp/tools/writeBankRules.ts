/**
 * MCP write tools: bank categorisation rules.
 *
 * None of these post anything by themselves — a rule only posts when an import
 * or a rule sweep runs it — so none is `requiresPost`. `auto_create_entry` is
 * the field that decides whether a rule posts a journal on match, so it is
 * stated in every description and surfaced in every reply rather than buried.
 *
 * `disable_bank_rule` is separate from `update_bank_rule` because "stop this
 * rule firing" is the correction an agent needs most — during the Velocity
 * Fibre migration a rule still pointing at an account being retired would have
 * silently re-routed every future reload back to it — and it should not
 * require restating the rule's whole shape.
 */
import type { McpTool } from '../types';
import { createRule, updateRule, toggleRule } from '@/modules/accounting/services/bank/bankRulesService';
import type {
  RuleMatchField,
  RuleMatchType,
  RuleVatCode,
} from '@/modules/accounting/types/bank.types';
import {
  NOT_FOUND,
  guardCastableArgs,
  ok,
  safeErrorText,
  strArg,
  toolError,
} from './toolHelpers';
import {
  MATCH_FIELDS,
  MATCH_TYPES,
  VAT_CODES,
  RULE_TARGET_PROPERTIES,
  compactRule,
  loadRule,
  parsePriority,
  parseRefs,
  refsBelongToCompany,
} from './bankRuleShared';

export const createBankRuleTool: McpTool = {
  name: 'create_bank_rule',
  description:
    'Create a bank categorisation rule. It applies to transactions matched from now on — creating a rule does NOT post anything by itself. ' +
    'auto_create_entry=true means every future match posts a journal automatically without review; leave it false unless that is what you want. ' +
    'Check list_bank_rules first: a more specific rule with a lower priority wins, and two rules matching the same pattern is how a migration gets silently undone.',
  scope: 'write:bank-tx',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      rule_name: { type: 'string' },
      match_field: { type: 'string', enum: [...MATCH_FIELDS] },
      match_type: { type: 'string', enum: [...MATCH_TYPES] },
      match_pattern: { type: 'string' },
      ...RULE_TARGET_PROPERTIES,
      idempotency_key: { type: 'string' },
    },
    required: ['rule_name', 'match_field', 'match_type', 'match_pattern', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ruleName = strArg(args, 'rule_name');
    const matchPattern = strArg(args, 'match_pattern');
    const matchField = strArg(args, 'match_field');
    const matchType = strArg(args, 'match_type');
    if (!ruleName) return toolError('rule_name is required');
    if (!matchPattern) return toolError('match_pattern is required');
    if (!matchField || !(MATCH_FIELDS as readonly string[]).includes(matchField)) {
      return toolError(`match_field must be one of: ${MATCH_FIELDS.join(', ')}`);
    }
    if (!matchType || !(MATCH_TYPES as readonly string[]).includes(matchType)) {
      return toolError(`match_type must be one of: ${MATCH_TYPES.join(', ')}`);
    }
    const vatCode = strArg(args, 'vat_code');
    if (vatCode && !(VAT_CODES as readonly string[]).includes(vatCode)) {
      return toolError(`vat_code must be one of: ${VAT_CODES.join(', ')}`);
    }
    const priority = parsePriority(args);
    if (priority === 'invalid') return toolError('priority must be a whole number');

    const bad = guardCastableArgs(args, { uuid: ['gl_account_id', 'supplier_id', 'client_id'] });
    if (bad) return bad;

    const refs = parseRefs(args);
    if (!(await refsBelongToCompany(ctx.companyId, refs))) return toolError(NOT_FOUND);

    try {
      const rule = await createRule(
        ctx.companyId,
        {
          ruleName,
          matchField: matchField as RuleMatchField,
          matchType: matchType as RuleMatchType,
          matchPattern,
          ...refs,
          descriptionTemplate: strArg(args, 'description_template'),
          priority,
          autoCreateEntry: args.auto_create_entry === true,
          vatCode: vatCode as RuleVatCode | undefined,
        },
        ctx.userId,
      );
      return ok(compactRule(rule));
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to create bank rule.'));
    }
  },
};

export const updateBankRuleTool: McpTool = {
  name: 'update_bank_rule',
  description:
    'Update a bank categorisation rule. Pass only the fields to change. Re-pointing gl_account_id is the fix for a rule that still routes to a retired account. ' +
    'To only stop a rule firing, use disable_bank_rule — it needs nothing but the id.',
  scope: 'write:bank-tx',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      rule_id: { type: 'string' },
      rule_name: { type: 'string' },
      match_field: { type: 'string', enum: [...MATCH_FIELDS] },
      match_type: { type: 'string', enum: [...MATCH_TYPES] },
      match_pattern: { type: 'string' },
      is_active: { type: 'boolean' },
      ...RULE_TARGET_PROPERTIES,
      idempotency_key: { type: 'string' },
    },
    required: ['rule_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ruleId = strArg(args, 'rule_id');
    if (!ruleId) return toolError('rule_id is required');
    const bad = guardCastableArgs(args, {
      uuid: ['rule_id', 'gl_account_id', 'supplier_id', 'client_id'],
    });
    if (bad) return bad;

    const matchField = strArg(args, 'match_field');
    if (matchField && !(MATCH_FIELDS as readonly string[]).includes(matchField)) {
      return toolError(`match_field must be one of: ${MATCH_FIELDS.join(', ')}`);
    }
    const matchType = strArg(args, 'match_type');
    if (matchType && !(MATCH_TYPES as readonly string[]).includes(matchType)) {
      return toolError(`match_type must be one of: ${MATCH_TYPES.join(', ')}`);
    }
    const vatCode = strArg(args, 'vat_code');
    if (vatCode && !(VAT_CODES as readonly string[]).includes(vatCode)) {
      return toolError(`vat_code must be one of: ${VAT_CODES.join(', ')}`);
    }
    const priority = parsePriority(args);
    if (priority === 'invalid') return toolError('priority must be a whole number');

    // Ownership of the rule AND of anything it is being re-pointed at, both
    // answered from reads before the first write.
    if (!(await loadRule(ctx.companyId, ruleId))) return toolError(NOT_FOUND);
    const refs = parseRefs(args);
    if (!(await refsBelongToCompany(ctx.companyId, refs))) return toolError(NOT_FOUND);

    try {
      const rule = await updateRule(ctx.companyId, ruleId, {
        ruleName: strArg(args, 'rule_name'),
        matchField: matchField as RuleMatchField | undefined,
        matchType: matchType as RuleMatchType | undefined,
        matchPattern: strArg(args, 'match_pattern'),
        ...refs,
        descriptionTemplate: strArg(args, 'description_template'),
        priority,
        ...(typeof args.auto_create_entry === 'boolean'
          ? { autoCreateEntry: args.auto_create_entry }
          : {}),
        ...(typeof args.is_active === 'boolean' ? { isActive: args.is_active } : {}),
        vatCode: vatCode as RuleVatCode | undefined,
      });
      return ok(compactRule(rule));
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to update bank rule.'));
    }
  },
};

export const disableBankRuleTool: McpTool = {
  name: 'disable_bank_rule',
  description:
    'Deactivate a bank categorisation rule so it stops matching. The rule is kept, not deleted — pass enable=true to turn it back on. This is the safe way to stop a rule that posts to an account you are retiring.',
  scope: 'write:bank-tx',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      rule_id: { type: 'string' },
      enable: { type: 'boolean', description: 'Default false (disable). true re-activates the rule.' },
      idempotency_key: { type: 'string' },
    },
    required: ['rule_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ruleId = strArg(args, 'rule_id');
    if (!ruleId) return toolError('rule_id is required');
    const bad = guardCastableArgs(args, { uuid: ['rule_id'] });
    if (bad) return bad;

    const rule = await loadRule(ctx.companyId, ruleId);
    if (!rule) return toolError(NOT_FOUND);

    const isActive = args.enable === true;
    if (rule.isActive === isActive) {
      // Report the no-op rather than issuing a write: an agent retrying on the
      // same key must not read "changed" when nothing did.
      return ok({ id: ruleId, rule_name: rule.ruleName, is_active: isActive, already: true });
    }

    await toggleRule(ctx.companyId, ruleId, isActive);
    return ok({ id: ruleId, rule_name: rule.ruleName, is_active: isActive, already: false });
  },
};
