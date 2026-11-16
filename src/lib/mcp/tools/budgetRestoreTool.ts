/**
 * MCP write tool restore_budget_version (Hein's ruling 1, 2026-11-16): undo the most recent unrestored MCP
 * amount write of a version (its snapshot, migration 999f), only while the version's token still equals the
 * token that write left. The before-values go back through the grid save as the token user (every save rule,
 * the save's own audit row); the snapshot is then marked restored by the database's stamps. A refusal names
 * why (the cells that differ now, capped; amounts only with read:reports). dry_run runs the same restore in a
 * savepoint that is always rolled back.
 */
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { planRestore, restoreSnapshot } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { UUID_RE } from '@/lib/validation';
import type { McpTool } from '../types';
import { BUDGET_WRITE_SCOPE, FIGURES_HIDDEN_NOTE, figuresAllowed, isResult } from './budgetToolArgs';
import { currentCells } from './budgetDiffView';
import { loadModel } from './budgetAmountWrite';
import { ok, toolError } from './toolHelpers';

export const restoreBudgetVersionTool: McpTool = {
  name: 'restore_budget_version',
  description:
    'Undo the most recent MCP amount write (set_budget_amounts / set_budget_annual) on a budget version: every cell it changed goes back to its value before. '
    + 'TRAPS: only the version\'s MOST RECENT unrestored write, and only while nobody has changed the version since (its version_token still equals the one that write left: another save, a status move or a driver recompute makes it refuse, naming the cells that differ). '
    + 'Each write is restored at most once; a restore cannot itself be undone, and the write before it then cannot be restored either (the version changed). snapshot_id (from the write\'s reply) is optional and, when given, must be that most recent write. '
    + 'The restore is a grid save as you (audited as you), so every save rule applies (a locked version or a slice under review is refused). dry_run true checks it all and changes nothing.',
  scope: BUDGET_WRITE_SCOPE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' }, snapshot_id: { type: 'string', format: 'uuid' },
      dry_run: { type: 'boolean' }, idempotency_key: { type: 'string' },
    },
    required: ['version_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (args.snapshot_id !== undefined && (typeof args.snapshot_id !== 'string' || !UUID_RE.test(args.snapshot_id))) return toolError('invalid snapshot_id');
    const model = await loadModel(ctx, args.version_id);
    if (isResult(model)) return model;
    const versionId = model.version!.id;
    const figures = figuresAllowed(ctx);
    const cents = new Map([...currentCells(model)].map(([k, v]) => [k, v.cents]));
    const plan = await planRestore(ctx.companyId, versionId, (args.snapshot_id as string | undefined) ?? null, { token: model.updatedAt!, cents });
    if (!plan.ok) {
      const cells = (plan.differing ?? []).map(({ cell, now }) => ({
        account_id: cell.a, cc1_id: cell.c1, cc2_id: cell.c2, bu_id: cell.b, month: cell.m,
        ...(figures ? { written: cell.after, now } : {}),
      }));
      const detail = cells.length > 0 ? ` Differing cells (up to ${cells.length}): ${JSON.stringify(cells)}` : '';
      return toolError(`${plan.reason}.${detail}${figures || cells.length === 0 ? '' : ` ${FIGURES_HIDDEN_NOTE}`}`);
    }
    const summary = { version_id: versionId, snapshot: plan.snapshot, cells: plan.cells.length };
    if (args.dry_run === true) {
      try {
        await inRolledBackSavepoint('mcp_budget_restore_dry', () => restoreSnapshot(ctx.companyId, ctx.userId, versionId, plan));
      } catch (err) {
        if (err instanceof BudgetVersionError) return toolError(`The restore would be refused: ${err.message}`);
        throw err;
      }
      return { ...ok({ dry_run: true, ...summary, version_token: model.updatedAt, next_step: 'Call again with dry_run false to restore.' }), wroteNothing: true };
    }
    // The restore writes and then marks: a failure at either throws and the registry's savepoint takes both back.
    const saved = await restoreSnapshot(ctx.companyId, ctx.userId, versionId, plan);
    return ok({ ...summary, restored: saved.saved + saved.deleted, version_token: saved.updatedAt });
  },
};
