/**
 * The one write path of the MCP budget amount tools (set_budget_amounts, set_budget_annual, import_budget_workbook): read the
 * version's grid as the token user sees it (a budget holder sees their slices), resolve every account and
 * member by id or code (the import's resolver), plan the cells (`cellWritePlan`), then either
 *  - DRY RUN: run the grid save itself (`saveCells`, as the token user) inside a savepoint that is always
 *    rolled back, read what it left before the rollback, and answer that ACTUAL diff (driver resets and
 *    recomputed dependents included), the version token and the `plan_hash` (`wroteNothing`: the
 *    idempotency key stays free for the live call); or
 *  - LIVE: refuse any refused cell (all or nothing), recompute the plan from the current state and refuse
 *    unless its hash equals the dry run's `plan_hash` (required when the caller sets `hashRequired`: set_budget_amounts
 *    for anything but one cell merged, set_budget_annual and import_budget_workbook always), save
 *    (`saveCells`: its compare-and-set on the token, its audit row as the token user), read what the save
 *    left, then record the undo snapshot in the same savepoint.
 * Refusals before the save return a toolError; the save's own refusals roll back its own savepoint, so
 * they are answered too; anything after it (the read, the snapshot) throws, and the registry rolls it all back.
 */
import { perHeadAccessOf } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { BudgetVersionStaleError, MAX_SAVE_CELLS, saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { planCellWrites, type PlanInput, type WriteMode } from '@/modules/accounting/services/budgets/cellWritePlan';
import { recordSnapshot } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { budgetPlanHash } from '@/modules/accounting/services/budgets/budgetPlanHash';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import type { McpToolContext, McpToolResult } from '../types';
import { isResult, ownVersion } from './budgetToolArgs';
import { planHashRefusal, staleRefusal, STALE_SINCE_DRY_RUN } from './budgetWriteGate';
import { actualDiff, cellMap, diffListing, sectionTotals, snapshotCells, type CellMap, type DiffPage, type RowRefusal } from './budgetDiffView';
import { ok, toolError } from './toolHelpers';

export { STALE_SINCE_DRY_RUN };

/** The version's grid as the token user sees it, or the shared NOT_FOUND. */
export async function loadModel(ctx: McpToolContext, versionId: unknown): Promise<GridReadModel | McpToolResult> {
  const version = await ownVersion(ctx, versionId);
  if (isResult(version)) return version;
  return loadGridReadModel(ctx.companyId, { versionId: version.id }, perHeadAccessOf(ctx.companyRole), ctx.userId);
}

/** A row the rounding left with its last month on the other side of zero (the grid's own notice). */
export interface RoundingNotice { i: number; account: string; reason: string }

export interface AmountWrite {
  tool: string;
  model: GridReadModel;
  mode: WriteMode;
  inputs: PlanInput[];
  rowRefusals: RowRefusal[];
  dryRun: boolean;
  versionToken: string | null;
  planHash: string | null;
  /** True when the live call must carry the dry run's plan_hash. */
  hashRequired: boolean;
  /** The caller's own rule for the refusal text: "plan_hash is required <hashWhy>: ...". */
  hashWhy: string;
  page: DiffPage;
  notices?: RoundingNotice[];
  /** Fields the tool adds to every reply (import_budget_workbook: the file's own counts, warnings and conflicts). */
  extra?: Record<string, unknown>;
}

const MAX_REFUSALS_NAMED = 20;

function refusalText(refused: Array<{ i: unknown; reason?: unknown }>, total: number): string {
  const named = refused.slice(0, MAX_REFUSALS_NAMED).map((r) => `cell ${r.i === null ? '(cleared)' : String(r.i)}: ${String(r.reason)}`);
  return `${total} cell${total === 1 ? ' is' : 's are'} refused, so nothing was written (a write is all or nothing): ${named.join('; ')}`
    + `${total > named.length ? `; +${total - named.length} more (dry run with list_offset to page)` : ''}. Fix or remove them and try again.`;
}

export async function runAmountWrite(ctx: McpToolContext, w: AmountWrite): Promise<McpToolResult> {
  const { model } = w;
  const versionId = model.version!.id;
  const token = model.updatedAt!;
  const before = cellMap(model.cells);
  const plan = planCellWrites(w.mode, w.inputs, before);
  if (plan.save.length > MAX_SAVE_CELLS) {
    return toolError(`This write changes ${plan.save.length} cells; one call writes at most ${MAX_SAVE_CELLS}. Split it by account or section (each call is its own dry run and plan_hash).`);
  }
  const refused = w.rowRefusals.length + plan.entries.filter((e) => e.status === 'refused').length;
  const hash = budgetPlanHash(versionId, `${w.tool}:${w.mode}`, token, plan.entries
    .filter((e) => e.status !== 'refused' && e.status !== 'unchanged')
    .map((e) => ({ key: e.key, before: e.before, beforeSource: before.get(e.key)?.source ?? null, after: e.after })));
  const base = {
    version_id: versionId, version: { name: model.version!.name, fiscal_year: model.version!.fiscalYear, status: model.version!.status },
    mode: w.mode, ...(w.notices && w.notices.length > 0 ? { notices: w.notices } : {}), ...w.extra,
  };
  const readAfter = async (): Promise<CellMap> => cellMap((await loadGridCells(ctx.companyId, { versionId }, ctx.userId)).cells);

  const refusals = () => {
    const listing = diffListing(model, actualDiff(plan.entries, before, before), w.rowRefusals, { offset: 0, limit: MAX_REFUSALS_NAMED });
    return refusalText(listing.cells.filter((c) => c.status === 'refused') as Array<{ i: unknown; reason?: unknown }>, refused);
  };

  if (w.dryRun) {
    // The save runs (rolled back) on the cells that are not refused, so even with refused rows the other
    // cells, their sources and the totals are what the save would leave. A save of that subset can be refused
    // for a reason the whole request would not have (a refused clear leaves an old-level cell standing), so
    // with refused rows a save refusal is never answered: the other cells are checked once nothing is refused.
    // While any row is refused, a replace's accounts that would clear unlisted cells are held back whole: a
    // refused row may be the very cell the caller meant to keep, and the account's new cells without those
    // clears could break the one-level rule, a refusal the full request would not get.
    const holdClears = refused > 0 && w.mode === 'replace';
    const accountOf = (key: string) => key.slice(0, key.indexOf('|'));
    const held = new Set(holdClears ? plan.entries.filter((e) => e.index === null).map((e) => accountOf(e.key)) : []);
    let entries = plan.entries.filter((e) => e.status === 'refused' || !held.has(accountOf(e.key)));
    let unchecked = false;
    const trial = plan.save.filter((c) => !held.has(accountOf(cellKey(c))));
    let after: CellMap = before;
    if (trial.length > 0) {
      try {
        await inRolledBackSavepoint('mcp_budget_dry_run', async () => {
          await saveCells(ctx.companyId, ctx.userId, { versionId, expectedUpdatedAt: token, cells: trial });
          after = await readAfter();
        });
      } catch (err) {
        if (!(err instanceof BudgetVersionError)) throw err;
        if (refused === 0) return toolError(`The save would be refused: ${err.message}`);
        unchecked = true;
        entries = entries.filter((e) => e.status === 'refused');
      }
    }
    const listing = diffListing(model, actualDiff(entries, before, after), w.rowRefusals, w.page);
    const ready = refused === 0 && plan.save.length > 0;
    return {
      ...ok({
        dry_run: true, ...base, ready: refused === 0, version_token: token, plan_hash: ready ? hash : null, counts: listing.counts,
        cells: listing.cells, listed_total: listing.listed_total, truncated: listing.truncated, next_offset: listing.next_offset,
        totals: unchecked ? null : sectionTotals(model, before, after),
        next_step: refused > 0
          ? `Fix or remove the refused cells, then dry-run again.${unchecked ? ' The other cells are checked once nothing is refused.'
            : held.size > 0 ? ' Accounts whose other cells replace would clear are listed once nothing is refused.' : ''}`
          : plan.save.length === 0 ? 'Nothing would change.' : `Apply: call ${w.tool} again with the same arguments, dry_run false and this plan_hash.`,
      }),
      wroteNothing: true,
    };
  }

  const stale = staleRefusal(w.versionToken, token);
  if (stale) return stale;
  if (refused > 0) return toolError(refusals());
  if (plan.save.length === 0) return { ...ok({ ...base, saved: 0, deleted: 0, version_token: token, note: 'Nothing changed: every cell already holds its amount.' }), wroteNothing: true };
  const planRefused = planHashRefusal({ tool: w.tool, given: w.planHash, hash, required: w.hashRequired, why: w.hashWhy });
  if (planRefused) return planRefused;

  let saved;
  try {
    saved = await saveCells(ctx.companyId, ctx.userId, { versionId, expectedUpdatedAt: token, cells: plan.save });
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
  const after = await readAfter();
  const diff = actualDiff(plan.entries, before, after);
  const cells = snapshotCells(diff);
  const snapshotId = cells.length === 0 ? null : await recordSnapshot(ctx.companyId, {
    versionId, tool: w.tool, tokenJti: ctx.tokenJti, tokenBefore: token, tokenAfter: saved.updatedAt, cells,
  });
  const listing = diffListing(model, diff, [], w.page);
  return ok({
    ...base, saved: saved.saved, deleted: saved.deleted, recomputed: saved.recomputed ?? 0, version_token: saved.updatedAt,
    snapshot_id: snapshotId, ...(saved.driverWarnings && saved.driverWarnings.length > 0 ? { driver_warnings: saved.driverWarnings.length } : {}),
    ...(saved.frozenDriverCells ? { frozen_driver_cells: saved.frozenDriverCells.cells } : {}),
    counts: listing.counts, cells: listing.cells, listed_total: listing.listed_total, truncated: listing.truncated, next_offset: listing.next_offset,
    next_step: 'Saved as an edit of this version (audited as you). restore_budget_version undoes this write while nobody has changed the version since. '
      + (model.version!.status === 'draft' ? 'A person approves the version in IsaFlow when it is ready.' : ''),
  });
}
