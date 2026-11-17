/**
 * MCP write tool set_budget_drivers (budget tools PR 3): driver lines, override resets, planned hires and a
 * headcount refresh on one version, each through the service its app route calls (`saveDriver`, `deleteDriver`,
 * `resetOverride`, `refreshHeadcount`, `createHire` / `updateHire` / `deleteHire`: runDriverWrite's token
 * compare-and-set, holder slices, the recompute and one audit row per change, all as the token user).
 *  - DRY RUN: the same services in a savepoint that is always rolled back; the reply is what they left (every
 *    cell whose value or source moved, other accounts' recomputed dependents included, the driver lines and hires
 *    before and after) and a `plan_hash`; `wroteNothing` frees the key.
 *  - LIVE: needs that plan_hash (always: one change can recompute many cells), recomputed from the current state;
 *    then the changes in order (the token chained), the cells re-read, and a `budget_write_snapshots` record of
 *    every changed cell (tool set_budget_drivers). restore_budget_version refuses that record: it undoes amount
 *    writes only. Pre-write refusals answer; a refusal after the first change wrote throws, so the registry's
 *    savepoint takes the whole call back.
 */
import { loadGridCells } from '@/modules/accounting/services/budgets/gridReadModel';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSave';
import { budgetStatePlanHash } from '@/modules/accounting/services/budgets/budgetPlanHash';
import { DRIVER_WRITE_TOOL, recordSnapshot } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { listDriverLines, listPlannedHires, type StoredPlannedHire } from '@/modules/accounting/services/budgets/drivers/driverRepository';
import type { StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { loadHolderScope } from '@/modules/accounting/services/budgets/holderScope';
import type { BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { McpTool, McpToolContext, McpToolResult } from '../types';
import { BUDGET_WRITE_FENCE, isResult, planHashArg, versionTokenArg } from './budgetToolArgs';
import { cellMap, sectionTotals, DIFF_LIST_MAX, type CellMap } from './budgetDiffView';
import { loadModel } from './budgetAmountWrite';
import { planHashRefusal, staleRefusal } from './budgetWriteGate';
import { listPage } from './budgetPaging';
import { budgetLabels, type BudgetLabels } from './budgetLabels';
import { driverChangesLimit } from './budgetToolRateLimits';
import { MAX_DRIVER_CHANGES, parseDriverChanges, type DriverChange } from './budgetDriverArgs';
import { applyDriverChanges, DriverChangeRefused } from './budgetDriverApply';
import { driverCellChanges, driverCellListing, driverLineView, driverSnapshotCells, hireView } from './budgetDriverView';
import { DRIVER_CHANGES_SCHEMA } from './budgetDriverSchema';
import { ok, toolError } from './toolHelpers';

export { MAX_DRIVER_CHANGES };
const LIST_DEFAULT = 100;

interface DriverState { cells: CellMap; lines: StoredDriverLine[]; hires: StoredPlannedHire[] }

async function readState(ctx: McpToolContext, versionId: string): Promise<DriverState> {
  const cells = cellMap((await loadGridCells(ctx.companyId, { versionId }, ctx.userId)).cells);
  return { cells, lines: await listDriverLines(ctx.companyId, versionId), hires: await listPlannedHires(ctx.companyId, versionId) };
}

/** A stored row's content: everything but its token (inside one transaction every write stamps the same now()). */
const content = (row: object) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'updatedAt'));

/**
 * The hash over the changes and everything they start from: the version's status, its slice reviews (review round 1,
 * F3: inside one transaction the token cannot show an approve or a slice move; a superset of the slices the plan
 * touches, since a hire or a headcount refresh reaches per_head rows anywhere), the stored lines and hires by
 * content, and every cell.
 */
async function planHash(ctx: McpToolContext, version: BudgetVersion, token: string, changes: readonly DriverChange[], s: DriverState): Promise<string> {
  const reviews = (await loadHolderScope(ctx.companyId, version.id, ctx.userId)).reviews
    .map((r) => [r.cc1Id, r.cc2Id, r.buId, r.status]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return budgetStatePlanHash(version.id, DRIVER_WRITE_TOOL, token, [
    version.status, reviews, changes, s.lines.map(content), s.hires.map(content), [...s.cells].sort(([a], [b]) => (a < b ? -1 : 1)),
  ]);
}

/** Driver lines (by row) and hires (by id) whose content differs, before and after. */
function stateDiff(before: DriverState, after: DriverState, l: BudgetLabels) {
  const rowOf = (d: StoredDriverLine) => `${d.glAccountId}|${d.cc1Id ?? ''}|${d.cc2Id ?? ''}|${d.buId ?? ''}`;
  const same = (x: object | undefined, y: object | undefined) => JSON.stringify(x && content(x)) === JSON.stringify(y && content(y));
  const pair = <T extends object>(b: Map<string, T>, a: Map<string, T>, view: (x: T) => unknown) => [...new Set([...b.keys(), ...a.keys()])]
    .filter((k) => !same(b.get(k), a.get(k)))
    .map((k) => ({ before: b.has(k) ? view(b.get(k)!) : null, after: a.has(k) ? view(a.get(k)!) : null }));
  return {
    driver_lines: pair(new Map(before.lines.map((d) => [rowOf(d), d])), new Map(after.lines.map((d) => [rowOf(d), d])), (d) => driverLineView(d, l)),
    planned_hires: pair(new Map(before.hires.map((h) => [h.id, h])), new Map(after.hires.map((h) => [h.id, h])), (h) => hireView(h, l)),
  };
}

const tooMany = (n: number) => `These changes change ${n} cells; one call changes at most ${MAX_SAVE_CELLS} (split the changes). Nothing was written.`;

async function run(
  ctx: McpToolContext, args: Record<string, unknown>, model: GridReadModel, version: BudgetVersion, raw: unknown[],
  versionToken: string | null, planHashGiven: string | null,
): Promise<McpToolResult> {
  const versionId = version.id;
  const token = model.updatedAt ?? version.updatedAt;
  const labels = budgetLabels(model);
  const before = await readState(ctx, versionId);
  const { changes, refusals } = await parseDriverChanges(ctx, model, before.lines, raw);
  const hash = await planHash(ctx, version, token, changes, before);
  const head = { version_id: versionId, version: { name: version.name, fiscal_year: version.fiscalYear, status: version.status } };
  const view = (after: DriverState, outcomes: unknown[]) => {
    const listing = driverCellListing(driverCellChanges(before.cells, after.cells), labels, listPage(args, LIST_DEFAULT, DIFF_LIST_MAX));
    return { ...listing, totals: sectionTotals(model, before.cells, after.cells), ...stateDiff(before, after, labels), changes: outcomes };
  };

  if (args.dry_run === true) {
    if (refusals.length > 0) {
      return { ...ok({ dry_run: true, ...head, ready: false, plan_hash: null, version_token: token, refusals, next_step: 'Fix or remove the refused changes, then dry-run again.' }), wroteNothing: true };
    }
    let after: DriverState = before;
    let outcomes: unknown[] = [];
    try {
      await inRolledBackSavepoint('mcp_budget_drivers_dry', async () => {
        outcomes = (await applyDriverChanges(ctx, versionId, token, changes)).outcomes;
        after = await readState(ctx, versionId);
      });
    } catch (err) {
      if (err instanceof DriverChangeRefused) return toolError(`The changes would be refused: change ${err.change.index} (${err.change.op}): ${err.message}`);
      throw err;
    }
    const changed = driverCellChanges(before.cells, after.cells).length;
    if (changed > MAX_SAVE_CELLS) return toolError(tooMany(changed));
    return {
      ...ok({
        dry_run: true, ...head, ready: true, version_token: token, plan_hash: hash, ...view(after, outcomes),
        next_step: 'Apply: call set_budget_drivers again with the same changes, dry_run false and this plan_hash. restore_budget_version does not undo driver changes.',
      }),
      wroteNothing: true,
    };
  }

  const stale = staleRefusal(versionToken, token);
  if (stale) return stale;
  if (refusals.length > 0) {
    const named = refusals.slice(0, 20).map((r) => `change ${r.i}: ${r.reason}`).join('; ');
    return toolError(`${refusals.length} change${refusals.length === 1 ? ' is' : 's are'} refused, so nothing was written (a call is all or nothing): ${named}. Dry-run to see them all.`);
  }
  const planRefused = planHashRefusal({ tool: 'set_budget_drivers', given: planHashGiven, hash, required: true, why: 'for every driver write (one change can recompute many cells)' });
  if (planRefused) return planRefused;
  let applied;
  try {
    applied = await applyDriverChanges(ctx, versionId, token, changes);
  } catch (err) {
    if (!(err instanceof DriverChangeRefused)) throw err;
    const text = `Change ${err.change.index} (${err.change.op}) was refused: ${err.message}. Nothing was written`;
    // The first change's own savepoint rolled it back; after a written change only a throw takes the call back.
    if (err.position === 0) return toolError(`${text}.`);
    throw new BudgetVersionError('BUDGET_VERSION_INPUT', `${text}: a call is all or nothing (the earlier changes were rolled back).`);
  }
  // From here the services have written: every failure throws (the registry's savepoint takes it all back).
  const after = await readState(ctx, versionId);
  const cells = driverCellChanges(before.cells, after.cells);
  if (cells.length > MAX_SAVE_CELLS) throw new BudgetVersionError('BUDGET_VERSION_INPUT', tooMany(cells.length));
  const snapshotId = cells.length === 0 ? null : await recordSnapshot(ctx.companyId, {
    versionId, tool: DRIVER_WRITE_TOOL, tokenJti: ctx.tokenJti, tokenBefore: token, tokenAfter: applied.token, cells: driverSnapshotCells(cells),
  });
  return ok({
    ...head, version_token: applied.token, snapshot_id: snapshotId, restorable: false, ...view(after, applied.outcomes),
    next_step: 'Saved as driver edits of this version (audited as you, one row per change). restore_budget_version does NOT undo them: '
      + 'to undo, call set_budget_drivers with the driver lines and hires listed under before. A person approves the version in IsaFlow.',
  });
}

export const setBudgetDriversTool: McpTool = {
  name: 'set_budget_drivers',
  description:
    'Change the drivers of one budget version: driver lines (set_driver, delete_driver), overrides (reset_override: a typed cell back to its driver), planned hires (add_hire, update_hire, delete_hire) and headcount (refresh_headcount). '
    + 'TRAPS FIRST: restore_budget_version does NOT undo this (it undoes amount writes only, and refuses one once drivers changed after it); the reply lists every driver line and hire as it was before, which is how to undo. '
    + 'One driver per row (account at one level: company, or one cc1, cc2 or bu member, the level the account is budgeted at in the version; never two dimensions); a driver writes only its months, never a closed (actual) month and never an override; '
    + 'set_driver replaces the row\'s driver; delete_driver turns the row\'s overrides into typed figures; a per_head driver reads payroll headcount on its own write and on refresh_headcount only. amount is a decimal STRING (rand per month, or per head); pct a number (4 decimals). '
    + 'delete_driver, update_hire and delete_hire name rows that exist before the call: a row or hire made by an earlier change of the same call cannot be named (call again). '
    + 'Refused on a locked version and, for a budget holder, outside their slices or in a slice under review. The changed amounts are the version\'s at once: get_three_way and the reports read the changed amounts. '
    + 'WORKFLOW: 1) dry_run true: the real changes rolled back, answering every cell they would change (other accounts\' recomputed dependents included), section totals before and after, the driver lines and hires before and after, and plan_hash; '
    + '2) the same call with dry_run false and that plan_hash (always required). If the version changed since, it is refused: dry-run again. The recomputed values are not bound by plan_hash (a payroll headcount can move); the live reply lists what was written. '
    + `At most ${MAX_DRIVER_CHANGES} changes and ${MAX_SAVE_CELLS} changed cells per call, all or nothing. Each change is audited as you. Needs write:budgets and read:reports.`,
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      version_id: { type: 'string', format: 'uuid' },
      changes: DRIVER_CHANGES_SCHEMA,
      plan_hash: { type: 'string', description: 'The plan_hash your dry run returned (required to apply).' },
      version_token: { type: 'string', description: 'Optional: refused when the version changed since you read it.' },
      dry_run: { type: 'boolean' },
      list_offset: { type: 'integer', minimum: 0 }, list_limit: { type: 'integer', minimum: 1, maximum: DIFF_LIST_MAX },
      idempotency_key: { type: 'string' },
    },
    required: ['version_id', 'changes', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!Array.isArray(args.changes) || args.changes.length === 0) return toolError('changes must list at least one change');
    if (args.changes.length > MAX_DRIVER_CHANGES) return toolError(`changes lists ${args.changes.length} changes; one call makes at most ${MAX_DRIVER_CHANGES}`);
    // Review round 2 (L-2): every argument that needs no read is checked first and costs nothing; the bucket is
    // charged before the grid read, so a call that reads anything is counted.
    const versionToken = versionTokenArg(args);
    if (isResult(versionToken)) return versionToken;
    const planHashGiven = planHashArg(args);
    if (isResult(planHashGiven)) return planHashGiven;
    const limited = await driverChangesLimit(ctx, args.changes.length);
    if (limited) return limited;
    const model = await loadModel(ctx, args.version_id);
    if (isResult(model)) return model;
    if (model.version === null) return toolError('Not found');
    return run(ctx, args, model, model.version, args.changes, versionToken, planHashGiven);
  },
};
