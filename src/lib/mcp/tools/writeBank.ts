/**
 * MCP write tool: suggest_bank_allocation. Records allocation SUGGESTIONS for
 * bank transactions (suggested_* columns) via the same smart-categorization
 * service the UI uses — it never posts a journal or changes tx status. The
 * apply path (allocateTransaction) is deliberately NOT exposed here.
 */
import type { McpTool } from '../types';
import { bulkCategorize } from '@/modules/accounting/services/core/smartCategorizationService';
import { ok, safeErrorText, toolError } from './toolHelpers';

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
    const ids = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (ids.length === 0) return toolError('transaction_ids must contain string ids');
    if (ids.length > MAX_TX) return toolError(`At most ${MAX_TX} transaction ids per call`);
    try {
      const result = await bulkCategorize(ctx.companyId, ids); // companyId from ctx ONLY
      return ok(result);
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to suggest allocations.'));
    }
  },
};
