/**
 * MCP write tool delete_budget_version (review round 1, the undo of a version an agent created): the app's
 * own `deleteVersion` (DELETE /api/accounting/budget-versions/[id]) as the token user, so the app's rules
 * hold: never the primary, never a locked version, an approved one only by an owner or admin, one with budget
 * holders only by an owner or admin; one audit row. dry_run runs the same delete in a savepoint that is always
 * rolled back. Refusals from the service are thrown (its message reaches the agent; nothing is kept).
 */
import { deleteVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import type { McpTool } from '../types';
import { BUDGET_WRITE_FENCE, isResult, ownVersion } from './budgetToolArgs';
import { ok, toolError } from './toolHelpers';

export const deleteBudgetVersionTool: McpTool = {
  name: 'delete_budget_version',
  description:
    'Delete a budget version and every amount and driver line it holds (account notes belong to the year and stay). TRAPS: refused for the PRIMARY version (make another primary first) and a LOCKED one; '
    + 'an approved version, or one with budget holders, only by an owner or admin; it cannot be undone. dry_run true checks every rule and deletes nothing. Needs write:budgets and read:reports.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: { version_id: { type: 'string', format: 'uuid' }, dry_run: { type: 'boolean' }, idempotency_key: { type: 'string' } },
    required: ['version_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const version = await ownVersion(ctx, args.version_id);
    if (isResult(version)) return version;
    const actor = { userId: ctx.userId, role: ctx.companyRole ?? '' };
    const summary = { version_id: version.id, name: version.name, fiscal_year: version.fiscalYear, status: version.status, cells: version.amountCount };
    if (args.dry_run === true) {
      try {
        await inRolledBackSavepoint('mcp_budget_delete_dry', () => deleteVersion(ctx.companyId, version.id, actor));
      } catch (err) {
        if (err instanceof BudgetVersionError) return toolError(`The delete would be refused: ${err.message}`);
        throw err;
      }
      return { ...ok({ dry_run: true, ...summary, next_step: 'Call again with dry_run false to delete it.' }), wroteNothing: true };
    }
    await deleteVersion(ctx.companyId, version.id, actor);
    return ok({ deleted: true, ...summary });
  },
};
