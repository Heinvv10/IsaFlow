/**
 * The one write path of the MCP budget amount tools (set_budget_amounts, set_budget_annual): read the
 * version's grid as the token user sees it (a budget holder sees their slices), resolve every account and
 * member by id or code (the import's resolver), plan the cells (`cellWritePlan`), then either
 *  - DRY RUN: run the grid save itself (`saveCells`, as the token user) inside a savepoint that is always
 *    rolled back, so every rule the live save applies is applied here too, and answer the diff and the
 *    version token (`wroteNothing`: the idempotency key stays free for the live call); or
 *  - LIVE: require the dry run's token for a bulk write, refuse any refused cell (all or nothing),
 *    re-validate everything against the current state, save (`saveCells`: its compare-and-set on the
 *    token, its audit row as the token user), then record the undo snapshot in the same savepoint.
 * Refusals before the save return a toolError; the save's own refusals roll back its own savepoint, so
 * they are answered too; anything after the save (the snapshot) throws, and the registry rolls it all back.
 */
import { perHeadAccessOf } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { BudgetVersionStaleError, MAX_SAVE_CELLS, saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { parseKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { planCellWrites, type PlanInput, type WriteMode } from '@/modules/accounting/services/budgets/cellWritePlan';
import { recordSnapshot, type SnapshotCell } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import type { McpToolContext, McpToolResult } from '../types';
import { centsText, FIGURES_HIDDEN_NOTE, figuresAllowed, isResult, ownVersion } from './budgetToolArgs';
import { currentCells, diffListing, sectionTotals, type DiffPage, type RowRefusal } from './budgetDiffView';
import { ok, toolError } from './toolHelpers';

export const STALE_SINCE_DRY_RUN = 'The budget changed since your dry run (its version_token moved); nothing was written. Dry-run again and apply with the new version_token.';

/** The version's grid as the token user sees it, or the shared NOT_FOUND. */
export async function loadModel(ctx: McpToolContext, versionId: unknown): Promise<GridReadModel | McpToolResult> {
  const version = await ownVersion(ctx, versionId);
  if (isResult(version)) return version;
  return loadGridReadModel(ctx.companyId, { versionId: version.id }, perHeadAccessOf(ctx.companyRole), ctx.userId);
}

export interface AmountWrite {
  tool: string;
  model: GridReadModel;
  mode: WriteMode;
  inputs: PlanInput[];
  rowRefusals: RowRefusal[];
  dryRun: boolean;
  versionToken: string | null;
  /** True for a bulk write (more than one cell): the live call must carry the dry run's version_token. */
  tokenRequired: boolean;
  page: DiffPage;
}

const MAX_REFUSALS_NAMED = 20;

function refusalText(refused: Array<{ i: unknown; reason?: unknown }>, total: number): string {
  const named = refused.slice(0, MAX_REFUSALS_NAMED).map((r) => `cell ${r.i === null ? '(cleared)' : String(r.i)}: ${String(r.reason)}`);
  return `${total} cell${total === 1 ? ' is' : 's are'} refused, so nothing was written (a write is all or nothing): ${named.join('; ')}`
    + `${total > named.length ? `; +${total - named.length} more (dry run with list_offset to page)` : ''}. Fix or remove them and try again.`;
}

const snapshotCells = (entries: ReturnType<typeof planCellWrites>['entries']): SnapshotCell[] => entries
  .filter((e) => e.status === 'added' || e.status === 'changed' || e.status === 'removed')
  .map((e) => {
    const r = parseKey(e.key);
    return { a: r.glAccountId, c1: r.cc1Id, c2: r.cc2Id, b: r.buId, m: r.month, before: e.before === null ? null : centsText(e.before), after: e.after === null ? null : centsText(e.after) };
  });

export async function runAmountWrite(ctx: McpToolContext, w: AmountWrite): Promise<McpToolResult> {
  const { model } = w;
  const versionId = model.version!.id;
  const token = model.updatedAt!;
  const figures = figuresAllowed(ctx);
  const current = currentCells(model);
  const plan = planCellWrites(w.mode, w.inputs, current);
  if (plan.save.length > MAX_SAVE_CELLS) {
    return toolError(`This write changes ${plan.save.length} cells; one call writes at most ${MAX_SAVE_CELLS}. Split it by account or section (each call is its own dry run and token).`);
  }
  const listing = diffListing(model, plan.entries, w.rowRefusals, w.page, figures);
  const refused = listing.counts.refused;
  const base = {
    version_id: versionId, version: { name: model.version!.name, fiscal_year: model.version!.fiscalYear, status: model.version!.status },
    mode: w.mode, counts: listing.counts, ...(figures ? {} : { figures_hidden: FIGURES_HIDDEN_NOTE }),
  };

  if (w.dryRun) {
    if (refused === 0 && plan.save.length > 0) {
      try {
        await inRolledBackSavepoint('mcp_budget_dry_run', () => saveCells(ctx.companyId, ctx.userId, { versionId, expectedUpdatedAt: token, cells: plan.save }));
      } catch (err) {
        if (err instanceof BudgetVersionError) return toolError(`The save would be refused: ${err.message}`);
        throw err;
      }
    }
    return {
      ...ok({
        dry_run: true, ...base, ready: refused === 0, version_token: token,
        cells: listing.cells, listed_total: listing.listed_total, truncated: listing.truncated, next_offset: listing.next_offset,
        ...(figures ? { totals: sectionTotals(model, current, plan.entries) } : {}),
        next_step: refused > 0
          ? 'Fix or remove the refused cells, then dry-run again.'
          : plan.save.length === 0 ? 'Nothing would change.' : `Apply: call ${w.tool} again with the same arguments, dry_run false and this version_token.`,
      }),
      wroteNothing: true,
    };
  }

  if (w.tokenRequired && w.versionToken === null) {
    return toolError(`version_token is required for a write of more than one cell: call ${w.tool} with dry_run true, read the diff, then apply with the version_token it returns.`);
  }
  if (refused > 0) return toolError(refusalText(listing.cells.filter((c) => c.status === 'refused') as Array<{ i: unknown; reason?: unknown }>, refused));
  const expected = w.versionToken ?? token;
  if (expected !== token) return toolError(STALE_SINCE_DRY_RUN);
  if (plan.save.length === 0) return { ...ok({ ...base, saved: 0, deleted: 0, version_token: token, note: 'Nothing changed: every cell already holds its amount.' }), wroteNothing: true };

  let saved;
  try {
    saved = await saveCells(ctx.companyId, ctx.userId, { versionId, expectedUpdatedAt: expected, cells: plan.save });
  } catch (err) {
    // The save rolled back its own savepoint: nothing of this call is written, so the refusal is answered.
    if (err instanceof BudgetVersionStaleError) return toolError(STALE_SINCE_DRY_RUN);
    if (err instanceof BudgetVersionError) return toolError(err.message);
    throw err;
  }
  if (saved.saved === 0 && saved.deleted === 0) {
    return { ...ok({ ...base, saved: 0, deleted: 0, version_token: saved.updatedAt, note: 'Nothing changed.' }), wroteNothing: true };
  }
  // From here the save has written: any failure throws so the registry's savepoint takes the save back too.
  const snapshotId = await recordSnapshot(ctx.companyId, {
    versionId, tool: w.tool, tokenJti: ctx.tokenJti, tokenBefore: expected, tokenAfter: saved.updatedAt, cells: snapshotCells(plan.entries),
  });
  return ok({
    ...base, saved: saved.saved, deleted: saved.deleted, recomputed: saved.recomputed ?? 0, version_token: saved.updatedAt,
    snapshot_id: snapshotId, ...(saved.driverWarnings && saved.driverWarnings.length > 0 ? { driver_warnings: saved.driverWarnings.length } : {}),
    ...(saved.frozenDriverCells ? { frozen_driver_cells: saved.frozenDriverCells.cells } : {}),
    cells: listing.cells, listed_total: listing.listed_total, truncated: listing.truncated,
    next_step: 'Saved as a draft edit of this version (audited as you). restore_budget_version undoes this write while nobody has changed the version since. '
      + (model.version!.status === 'draft' ? 'A person approves the version in ISAFlow when it is ready.' : ''),
  });
}
