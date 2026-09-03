/**
 * MCP read tool: list_agent_postings. "What did the agent do?" — every journal
 * stamped mcp:<tool>:v1 in a date range. This is the review half of the
 * attribution safety model; pair it with reverse_bank_allocation to correct.
 *
 * SUPERSEDED by tools/auditTrail.ts. Kept registered because it is on the wire
 * and agents are mid-flight against it — and because its answer is still
 * correct, merely narrow. Its limit is structural: `posting_agent LIKE 'mcp:%'`
 * finds only the postings that were already provable, which on production is
 * 2,287 of Brightsphere's 4,949 journals. The other 2,589 are stamped
 * `human:<userId>` by createJournalEntry's fallback and are invisible here
 * whether a person typed them or not.
 */
import type { McpTool } from '../types';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';
import { clampLimit, guardCastableArgs, ok, safeErrorText, toolError } from './toolHelpers';

export const listAgentPostingsTool: McpTool = {
  name: 'list_agent_postings',
  description:
    'SUPERSEDED BY audit_trail — prefer that unless you are already paginating against this one. This tool can only see postings that are ALREADY provable (posting_agent LIKE \'mcp:%\'), so it is blind to agent work that was written without the stamp; audit_trail reports every posting with its actor and whether that actor was recorded or inferred. ' +
    'GL journal entries created by an MCP tool for this company, selected by ENTRY DATE (not by when the tool ran), with the tool that made each one. Covers every MCP connection on the company, not only this one, and includes entries that are still DRAFT (create_draft_journal) alongside posted ones — read the status field. Use to review what the agent did before accepting or reversing it. Each row carries reversed: true once a contra has been posted against it — status stays "posted" after a reversal, so reversed is the only signal that a posting has already been corrected; do not reverse those again. reversalOfId is set when the row is itself a reversal contra. Returns at most `limit` rows (default 50, max 100), newest entry date first — a range with more entries than that is truncated, not summarised.',
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
    if (!from || !to) return toolError('from and to are required, formatted YYYY-MM-DD');
    // Shape alone was not enough: these reach an entry_date comparison, where
    // '2026-02-31' is a 22008 and a read tool has no savepoint to contain it.
    const bad = guardCastableArgs(args, { date: ['from', 'to'] });
    if (bad) return bad;
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
