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
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { calculatePolicyDepreciation } from './farDepreciationService';
import type { DryRunJournal } from '@/lib/mcp/contracts';
import {
  loadDepreciationAssets,
  planDepreciationRun,
  type DepreciationBlocker,
  type DepreciationPlan,
} from './depreciationRunPlan';

export * from './depreciationRunPlan';

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
  total: number;
  periodDate: string;
  yyyymm: string;
  results: DepreciationRunResultRow[];
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
  const results: DepreciationRunResultRow[] = [];
  let processed = 0;
  let glFailed = 0;
  let skipped = plan.rows.length - plan.postable.length;

  for (const row of plan.postable) {
    const a = byId.get(row.assetId);
    if (!a) continue;
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
          taxOpeningAccDep: Number(a.tax_acc_dep),
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
    total: plan.eligibleTotal,
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

/**
 * The journals the run WOULD post, computed from the same plan and the same
 * pure calculator the live path uses.
 *
 * CONTRACTS.md §6: a dry run returns the journals, not a count and not a
 * message. Resolving the two system accounts here rather than in the tool is
 * what keeps a preview honest — if `depreciation_expense` or
 * `accumulated_depreciation` is not configured, this throws exactly as the live
 * run would, instead of previewing a posting that cannot happen.
 */
export async function previewDepreciationJournals(
  companyId: string,
  plan: DepreciationPlan,
  assets: DbRow[],
): Promise<DryRunJournal[]> {
  if (plan.postable.length === 0) return [];
  const expense = await getSystemAccount('depreciation_expense', companyId);
  const accumulated = await getSystemAccount('accumulated_depreciation', companyId);
  const byId = new Map(assets.map((a) => [String(a.id), a]));

  const journals: DryRunJournal[] = [];
  for (const row of plan.postable) {
    const a = byId.get(row.assetId);
    if (!a) continue;
    const policy = calculatePolicyDepreciation({
      cost: Number(a.cost),
      residualPct: Number(a.residual_pct ?? 0),
      usefulLifeYears: Number(a.useful_life_years ?? 0),
      purchaseDate: fmtDate(a.purchase_date),
      periodDate: plan.periodDate,
      openingAccDep: Number(a.policy_acc_dep),
      ...(a.disposal_date ? { disposalDate: fmtDate(a.disposal_date) } : {}),
    });
    // The live path posts nothing at or below zero, so neither does the preview.
    if (policy.monthlyDep <= 0) continue;

    journals.push({
      date: plan.periodDate,
      description: `Depreciation: ${row.name} (${row.assetNumber}) — ${row.entryNumber}`,
      fiscalPeriodId: plan.fiscalPeriodId,
      lines: [
        {
          accountId: expense.id,
          accountCode: expense.accountCode,
          accountName: expense.accountName,
          debit: policy.monthlyDep,
          credit: 0,
        },
        {
          accountId: accumulated.id,
          accountCode: accumulated.accountCode,
          accountName: accumulated.accountName,
          debit: 0,
          credit: policy.monthlyDep,
        },
      ],
      totalDebit: policy.monthlyDep,
      totalCredit: policy.monthlyDep,
    });
  }
  return journals;
}
