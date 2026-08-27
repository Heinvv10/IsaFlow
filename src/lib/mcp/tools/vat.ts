/**
 * MCP read tool: VAT201 status. Computes the return live for a period via
 * the same service the VAT-return report route uses.
 */
import type { McpTool } from '../types';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const vatStatusTool: McpTool = {
  name: 'vat_status',
  description:
    'VAT201 summary computed live for a VAT period: output/input tax boxes and net VAT due. Provide the VAT period start and end dates (YYYY-MM-DD; SA VAT periods are usually two months).',
  scope: 'read:vat',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date' },
      period_end: { type: 'string', format: 'date' },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const start = strArg(args, 'period_start');
    const end = strArg(args, 'period_end');
    if (!start || !end) return toolError('period_start and period_end are required (YYYY-MM-DD)');
    const bad = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (bad) return bad;
    return ok(await getVATReturn(ctx.companyId, start, end));
  },
};
