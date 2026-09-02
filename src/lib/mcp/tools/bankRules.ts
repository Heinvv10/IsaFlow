/**
 * MCP tools: bank categorisation rules.
 *
 * Bank rules auto-post journals, and the connector could not see them. During
 * the Velocity Fibre migration a rule — "Reload Somerset W — Card No. 4765" —
 * still pointed at an account being retired; left alone it would have silently
 * re-routed every future reload back to the dead account, undoing the
 * migration one transaction at a time. It was found by clicking through the
 * UI, because no tool could list rules and nothing warns that a rule exists
 * before it fires.
 *
 * `list_bank_rules` / `get_bank_rule` are the load-bearing half: an agent that
 * cannot see the rules cannot reason about what will happen to what it
 * imports. They are reads, and free.
 *
 * The writes are deliberately narrow. `disable_bank_rule` is separate from
 * `update_bank_rule` because "stop this rule firing" is the one correction an
 * agent needs most and it should not require restating the rule's whole shape.
 * None of these post anything by themselves — a rule only posts when
 * `apply_bank_rules`-style sweeps or an import run it — so none is
 * `requiresPost`. `auto_create_entry` is the field that decides whether a rule
 * posts a journal on match, so it is surfaced explicitly in every reply rather
 * than buried.
 */
import type { McpTool } from '../types';
import { getRules } from '@/modules/accounting/services/bank/bankRulesService';
import {
  NOT_FOUND,
  guardCastableArgs,
  ok,
  strArg,
  toolError,
} from './toolHelpers';
import { compactRule, loadRule } from './bankRuleShared';

export const listBankRulesTool: McpTool = {
  name: 'list_bank_rules',
  description:
    'List the bank categorisation rules for this company. Rules match incoming bank transactions and, when auto_create_entry is true, POST a journal automatically — so read this BEFORE importing a statement or retiring an account, otherwise a stale rule will silently re-route transactions to the old account. ' +
    'Returns every rule (active and inactive) ordered by priority, lowest first, which is the order they are evaluated in. Filter with account_id to find every rule pointing at one GL account — the check to run before deactivating it.',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'Only rules posting to this GL account UUID' },
      active_only: { type: 'boolean', description: 'Default false — inactive rules are returned too, because a disabled rule is still a thing an agent needs to see.' },
      search: { type: 'string', description: 'Case-insensitive match on rule name or match pattern' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { uuid: ['account_id'] });
    if (bad) return bad;

    const accountId = strArg(args, 'account_id');
    const search = strArg(args, 'search')?.toLowerCase();
    const activeOnly = args.active_only === true;

    let rules = await getRules(ctx.companyId);
    if (accountId) rules = rules.filter((r) => r.glAccountId === accountId);
    if (activeOnly) rules = rules.filter((r) => r.isActive);
    if (search) {
      rules = rules.filter(
        (r) =>
          r.ruleName.toLowerCase().includes(search) ||
          r.matchPattern.toLowerCase().includes(search),
      );
    }

    return ok({
      rules: rules.map(compactRule),
      total: rules.length,
      // Stated rather than implied: an agent reading `total` needs to know
      // whether it is looking at the whole picture before it concludes an
      // account is safe to retire.
      auto_posting_rules: rules.filter((r) => r.isActive && r.autoCreateEntry).length,
    });
  },
};

export const getBankRuleTool: McpTool = {
  name: 'get_bank_rule',
  description: 'Fetch one bank categorisation rule by id, including the GL account, supplier or customer it posts to.',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { rule_id: { type: 'string' } },
    required: ['rule_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ruleId = strArg(args, 'rule_id');
    if (!ruleId) return toolError('rule_id is required');
    const bad = guardCastableArgs(args, { uuid: ['rule_id'] });
    if (bad) return bad;

    const rule = await loadRule(ctx.companyId, ruleId);
    if (!rule) return toolError(NOT_FOUND);
    return ok(compactRule(rule));
  },
};
