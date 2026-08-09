/**
 * MCP read tool: get_match_candidates. Scored match shortlist for one bank
 * transaction — supplier invoices, customer invoices, POs, journal lines —
 * via the same service the recon UI uses. Read-only: suggests nothing,
 * changes nothing.
 */
import type { McpTool } from '../types';
import { getMatchCandidates } from '@/modules/accounting/services/bank/bankMatchCandidatesService';
import { ok, safeErrorText, toolError } from './toolHelpers';

export const getMatchCandidatesTool: McpTool = {
  name: 'get_match_candidates',
  description:
    'Scored match candidates for a single bank transaction (supplier invoices, customer invoices, purchase orders, journal lines). Read-only. Use before allocate_bank_transaction to decide what a line belongs to.',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { transaction_id: { type: 'string' } },
    required: ['transaction_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const txId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : '';
    if (!txId) return toolError('transaction_id is required');
    try {
      const result = await getMatchCandidates(txId, ctx.companyId); // companyId from ctx ONLY
      return ok(result);
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to load match candidates.'));
    }
  },
};
