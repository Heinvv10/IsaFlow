/**
 * MCP write tool restore_budget_version (Hein's ruling 1; review round 1): undo the version's most recent MCP
 * amount write (its snapshot, migration 999l) while nothing has changed it since: the token AND every cell's
 * value and source (budgetSnapshotRestore.planRestore), by its author or an owner / admin. The before-values go
 * back through the grid save as the token user (every save rule, the save's own audit row). dry_run runs the
 * same restore in a savepoint that is always rolled back and answers the plan_hash; a live restore of more
 * than one cell needs it and is refused when the plan changed since.
 */
import { BudgetVersionError, type BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { planRestore, restoreSnapshot } from '@/modules/accounting/services/budgets/budgetSnapshotRestore';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { UUID_RE } from '@/lib/validation';
import type { McpTool } from '../types';
import { BUDGET_WRITE_FENCE, isResult, PLAN_CHANGED, planHashArg } from './budgetToolArgs';
import { cellMap } from './budgetDiffView';
import { loadModel } from './budgetAmountWrite';
import { ok, toolError } from './toolHelpers';

/** The latest of the version's status stamps (approve, lock, unlock), P1's comparable UTC text, or null. */
const statusMovedAt = (v: BudgetVersion): string | null =>
  [v.approvedAt, v.lockedAt, v.unlockedAt].filter((t): t is string => t !== null).sort().at(-1) ?? null;

export const restoreBudgetVersionTool: McpTool = {
  name: 'restore_budget_version',
  description:
    'Undo the most recent MCP amount write (set_budget_amounts / set_budget_annual / import_budget_workbook) on a budget version: every cell it changed goes back to its value (and driver / typed source) before. '
    + 'TRAPS: only the version\'s MOST RECENT write, only while nobody has changed it since (the version token, its status and every cell of that write must be as the write left them; another save, an approve / lock / unlock or a driver recompute makes it refuse, naming the cells that differ), and only by whoever made the write or an owner or admin. '
    + 'An override the write reset to a driver that now computes the same value cannot be pinned again: that restore is refused. An override no driver covers any more (its driver\'s range shrank) comes back as a manual figure with its value. '
    + 'Each write is restored at most once and a restore cannot itself be undone; once the latest write is restored, earlier writes cannot be. snapshot_id (from the write\'s reply) is optional and, when given, must be that most recent write. '
    + 'WORKFLOW: dry_run true checks it all, changes nothing and answers plan_hash; then dry_run false with that plan_hash (required when the write changed more than one cell). The restore is a grid save as you (audited as you). Needs write:budgets and read:reports.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' }, snapshot_id: { type: 'string', format: 'uuid' },
      plan_hash: { type: 'string', description: 'The plan_hash your dry run returned.' },
      dry_run: { type: 'boolean' }, idempotency_key: { type: 'string' },
    },
    required: ['version_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (args.snapshot_id !== undefined && (typeof args.snapshot_id !== 'string' || !UUID_RE.test(args.snapshot_id))) return toolError('invalid snapshot_id');
    const planHash = planHashArg(args);
    if (isResult(planHash)) return planHash;
    const model = await loadModel(ctx, args.version_id);
    if (isResult(model)) return model;
    const versionId = model.version!.id;
    const plan = await planRestore(ctx.companyId, versionId, (args.snapshot_id as string | undefined) ?? null,
      { token: model.updatedAt!, cells: cellMap(model.cells), statusMovedAt: statusMovedAt(model.version!) }, { userId: ctx.userId, role: ctx.companyRole });
    if (!plan.ok) {
      const cells = (plan.differing ?? []).map(({ cell, now, nowSource }) => ({
        account_id: cell.a, cc1_id: cell.c1, cc2_id: cell.c2, bu_id: cell.b, month: cell.m, written: cell.after, now, now_source: nowSource,
      }));
      return toolError(`${plan.reason}.${cells.length > 0 ? ` Differing cells (${cells.length} of ${plan.differingCount ?? cells.length} listed): ${JSON.stringify(cells)}` : ''}`);
    }
    const summary = { version_id: versionId, snapshot: plan.snapshot, cells: plan.cells.length };
    if (args.dry_run === true) {
      try {
        await inRolledBackSavepoint('mcp_budget_restore_dry', () => restoreSnapshot(ctx.companyId, ctx.userId, versionId, plan));
      } catch (err) {
        if (err instanceof BudgetVersionError) return toolError(`The restore would be refused: ${err.message}`);
        throw err;
      }
      return { ...ok({ dry_run: true, ...summary, version_token: model.updatedAt, plan_hash: plan.planHash, next_step: 'Call again with dry_run false and this plan_hash to restore.' }), wroteNothing: true };
    }
    if (plan.cells.length > 1 && planHash === null) return toolError('plan_hash is required to restore a write of more than one cell: dry-run first and apply with its plan_hash.');
    if (planHash !== null && planHash !== plan.planHash) return toolError(PLAN_CHANGED);
    // The restore writes, checks and then marks: a failure at any step throws and the registry's savepoint takes it all back.
    const saved = await restoreSnapshot(ctx.companyId, ctx.userId, versionId, plan);
    return ok({ ...summary, restored: saved.saved + saved.deleted, version_token: saved.updatedAt });
  },
};
