/**
 * The EXECUTE half of the monthly depreciation run, and the one entry point the
 * REST route and the MCP tool share.
 *
 * Extracted from the inline SQL in `pages/api/accounting/run-depreciation.ts`
 * so an MCP tool can reach it: tools never write SQL. Nothing is forked — a
 * second copy of this loop would be the fifth answer to a question that already
 * has four.
 *
 * The guards all live in `depreciationRunPlan.ts` and run BEFORE anything is
 * written. This half writes and checks nothing, which is what makes a dry run
 * (plan without execute) structurally unable to pass where the live call
 * refuses.
 *
 * TWO DEFECTS WERE CORRECTED IN THE EXTRACTION, both in the direction the
 * route's own `periodDate` parameter already promised:
 *
 *  1. The journal's `entry_date` was `CURRENT_DATE` and its entry NUMBER was
 *     `DEP-<asset>-<TODAY's month>`, neither derived from `periodDate`, while
 *     `asset_period_ledger` was keyed on the period. Running March and then
 *     April within one calendar month therefore wrote two subledger periods and
 *     ONE journal — the second collided with the first entry number and was
 *     read as already posted — so accumulated depreciation understated by a
 *     whole period with nothing flagging it. Both now come from `periodDate`.
 *     All 19 `auto_depreciation` entries in production carry an entry number
 *     whose month equals their creation month, so no run has ever been made for
 *     a period other than the current one and the change is a no-op on history.
 *
 *  2. The run could post into a CLOSED fiscal period, because
 *     `postAssetDepreciationToGLThrows` INSERTs at status `posted` and never
 *     reaches `postJournalEntry`'s check. It now refuses before writing.
 */

import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { postDualDepreciationToLedger } from '@/modules/accounting/services/gl/glCrossModuleHooks';
import {
  loadDepreciationAssets,
  planDepreciationRun,
  type DepreciationBlocker,
  type DepreciationPlan,
} from './depreciationRunPlan';

export * from './depreciationRunPlan';
export * from './depreciationRunPreview';

export interface DepreciationRunResultRow {
  assetNumber: string;
  policyDep: number;
  taxDep: number;
  entryId: string | null;
}

export interface DepreciationRunResult {
  processed: number;
  skipped: number;
  glFailed: number;
  /**
   * Every asset considered. `processed + skipped + glFailed === total`.
   *
   * It used to be `eligibleTotal` while `skipped` counted every asset in the
   * company, because the eligibility filter moved out of the SQL and into the
   * plan — so `skipped > total` became an ordinary response. The two now
   * describe the same population and `eligible` reports the narrower count
   * separately.
   *
   * The identity is ENFORCED, not merely documented: a postable row whose asset
   * is absent from the array handed to `executeDepreciationRun` raises
   * `DepreciationPlanMismatchError` before the first write, rather than being
   * skipped past by a silent `continue` that accounted it nowhere.
   */
  total: number;
  /** Assets that passed status, price and threshold — the old `total`. */
  eligible: number;
  periodDate: string;
  yyyymm: string;
  results: DepreciationRunResultRow[];
}

/**
 * A postable row whose asset the caller did not hand back.
 *
 * Unreachable with both current callers, which pass ONE `assets` array to both
 * halves — and that is exactly why it must be loud. `if (!a) continue` accounted
 * such a row nowhere, so `processed + skipped + glFailed === total` held only
 * because of a coincidence between two callers. A third — a scheduled close, a
 * bureau batch, anything that re-fetches between plan and execute — would have
 * got a run that silently under-reports its own population, which is the shape
 * of partial run this module already learned to count loudly as `glFailed`.
 *
 * It is raised BEFORE the first write, so nothing needs unwinding.
 */
export class DepreciationPlanMismatchError extends Error {
  constructor(public readonly assetIds: string[]) {
    super(
      `depreciation plan names ${assetIds.length} asset(s) absent from the assets passed to `
      + 'executeDepreciationRun — plan and execute must be given the same rows',
    );
    this.name = 'DepreciationPlanMismatchError';
  }
}

export class DepreciationRunBlockedError extends Error {
  constructor(public readonly blocker: DepreciationBlocker) {
    super(blocker.detail);
    this.name = 'DepreciationRunBlockedError';
  }
}

/**
 * Posts the plan. Guards NOTHING — every refusal has already been made by
 * `planDepreciationRun`, and re-checking here would be a second implementation
 * of the same rules, free to drift.
 *
 * `postDualDepreciationToLedger` owns one savepoint per asset so a subledger
 * period row and its journal commit or roll back together, and it SWALLOWS a
 * failure into `glFailed` rather than throwing, so one bad asset cannot poison
 * the run. That count is reported; a caller that needs all-or-nothing must read
 * it rather than assume a success wrote everything.
 */
export async function executeDepreciationRun(
  companyId: string,
  userId: string,
  plan: DepreciationPlan,
  assets: DbRow[],
): Promise<DepreciationRunResult> {
  const byId = new Map(assets.map((a) => [String(a.id), a]));

  // The invariant `processed + skipped + glFailed === total` is enforced here,
  // before anything is written, rather than documented and hoped for. See
  // DepreciationPlanMismatchError.
  const unresolved = plan.postable.filter((r) => !byId.has(r.assetId)).map((r) => r.assetId);
  if (unresolved.length > 0) throw new DepreciationPlanMismatchError(unresolved);

  const results: DepreciationRunResultRow[] = [];
  let processed = 0;
  let glFailed = 0;
  let skipped = plan.rows.length - plan.postable.length;

  for (const row of plan.postable) {
    // Non-null by the guard above: every postable row resolved.
    const a = byId.get(row.assetId)!;
    const usefulLifeYears = Number(a.useful_life_years ?? 0);

    const { policyDep, taxDep, entryId, glFailed: assetGlFailed } =
      await postDualDepreciationToLedger(
        companyId,
        row.assetId,
        {
          cost: Number(a.cost),
          residualPct: Number(a.residual_pct ?? 0),
          usefulLifeYears,
          // Fall back to the policy life when no explicit tax life is set.
          taxLifeYears: Number(a.tax_life_years ?? a.useful_life_years ?? 0),
          purchaseDate: fmtDate(a.purchase_date),
          periodDate: plan.periodDate,
          openingAccDep: Number(a.policy_acc_dep),
          deferredTaxRate: Number(a.deferred_tax_rate),
          ...(a.disposal_date ? { disposalDate: fmtDate(a.disposal_date) } : {}),
        },
        plan.yyyymm,
        userId,
      );

    if (assetGlFailed) {
      // The whole period rolled back for this asset. Count it loudly — a silent
      // partial run understates accumulated depreciation until someone notices.
      glFailed += 1;
      results.push({ assetNumber: row.assetNumber, policyDep, taxDep, entryId: null });
      continue;
    }
    if (policyDep < 0.01 && taxDep < 0.01) { skipped += 1; continue; }

    results.push({ assetNumber: row.assetNumber, policyDep, taxDep, entryId });
    processed += 1;
  }

  log.info('Dual depreciation run completed', {
    processed, skipped, glFailed, total: plan.eligibleTotal, periodDate: plan.periodDate,
  }, 'accounting');

  return {
    processed,
    skipped,
    glFailed,
    total: plan.rows.length,
    eligible: plan.eligibleTotal,
    periodDate: plan.periodDate,
    yyyymm: plan.yyyymm,
    results,
  };
}

/** Plan then execute. The REST route calls this; the MCP tool needs the plan. */
export async function runDepreciation(
  companyId: string,
  userId: string,
  periodDate: string,
): Promise<DepreciationRunResult> {
  const assets = await loadDepreciationAssets(companyId);
  const plan = await planDepreciationRun(companyId, periodDate, assets);
  if (plan.blocker) throw new DepreciationRunBlockedError(plan.blocker);
  return executeDepreciationRun(companyId, userId, plan, assets);
}
