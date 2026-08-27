/**
 * MCP write tool: suggest_bank_allocation. Records allocation SUGGESTIONS for
 * bank transactions (suggested_* columns) via the same smart-categorization
 * service the UI uses — it never posts a journal or changes tx status. The
 * apply path (allocateTransaction) is deliberately NOT exposed here.
 */
import type { McpTool } from '../types';
import { bulkCategorize } from '@/modules/accounting/services/core/smartCategorizationService';
import { guardUuidList, ok, safeErrorText, toolError } from './toolHelpers';

const MAX_TX = 200;

export const suggestBankAllocationTool: McpTool = {
  name: 'suggest_bank_allocation',
  description:
    'Suggest GL allocations for uncategorised bank transactions (writes suggestions only — never posts or applies them; a human still confirms in the UI). Pass up to 200 transaction ids.',
  scope: 'write:bank-tx',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      transaction_ids: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TX,
        items: { type: 'string' },
      },
      idempotency_key: { type: 'string' },
    },
    required: ['transaction_ids', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const raw = args.transaction_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return toolError('transaction_ids must be a non-empty array');
    }
    if (raw.length > MAX_TX) return toolError(`At most ${MAX_TX} transaction ids per call`);
    // bulkCategorize casts the whole array to ::UUID[]: ONE malformed id fails
    // the statement, so all 200 suggestions are lost to a single typo — hence
    // the reported index, which the agent can act on directly.
    //
    // Validated against `raw`, NOT a filtered copy: dropping the bad entries
    // first would renumber everything after them, so the index in the message
    // would point at the wrong element of the array the agent sent.
    const bad = guardUuidList(raw, (i) => `transaction_ids[${i}]`);
    if (bad) return bad;
    const ids = raw as string[];
    try {
      const result = await bulkCategorize(ctx.companyId, ids); // companyId from ctx ONLY
      return ok(result);
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to suggest allocations.'));
    }
  },
};
