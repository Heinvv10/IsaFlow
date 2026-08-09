/**
 * MCP read tool: list_agent_postings. "What did the agent do?" — every journal
 * stamped mcp:<tool>:v1 in a date range. This is the review half of the
 * attribution safety model; pair it with reverse_bank_allocation to correct.
 */
import type { McpTool } from '../types';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';
import { clampLimit, ok, safeErrorText, toolError } from './toolHelpers';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const listAgentPostingsTool: McpTool = {
  name: 'list_agent_postings',
  description:
    'Every journal entry this connector posted in a date range, with the tool that posted it. Use to review what the agent did before accepting or reversing it. Max 100 rows.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'YYYY-MM-DD' },
      to: { type: 'string', description: 'YYYY-MM-DD' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const from = typeof args.from === 'string' ? args.from : '';
    const to = typeof args.to === 'string' ? args.to : '';
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return toolError('from and to are required, formatted YYYY-MM-DD');
    }
    try {
      // tenant from ctx ONLY; limit clamped here — inputSchema bounds are not
      // runtime-enforced (see toolHelpers.clampLimit / bank.ts).
      const rows = await listAgentPostings(ctx.companyId, from, to, clampLimit(args, 50, 100));
      return ok({ postings: rows, count: rows.length });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to list agent postings.'));
    }
  },
};
