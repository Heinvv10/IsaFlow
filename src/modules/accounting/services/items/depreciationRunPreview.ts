/**
 * What a dry run of the depreciation run returns.
 *
 * Split from `depreciationRunService.ts` to keep both files inside the 300-line
 * cap. It computes from the same plan and the same pure calculator the live
 * path uses, so a preview cannot drift from the posting.
 */

import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { calculatePolicyDepreciation, toDepreciationMethod } from './farDepreciationService';
import type { DepreciationPlan } from './depreciationRunPlan';
import type { DryRunJournal, DryRunSkip } from '@/lib/mcp/contracts';

/** The shape `getSystemAccount` resolves to. Not exported by its own module. */
type CachedSystemAccount = Awaited<ReturnType<typeof getSystemAccount>>;

export interface DepreciationPreview {
  journals: DryRunJournal[];
  /**
   * Assets the run WRITES but posts no journal for. They are neither journals
   * nor skips: the live call touches them.
   */
  writesWithoutJournal: DryRunSkip[];
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
): Promise<DepreciationPreview> {
  if (plan.postable.length === 0) return { journals: [], writesWithoutJournal: [] };

  // A missing system account is a PARTIAL run, not a failure: the live path
  // writes the asset_period_ledger row inside its savepoint and THEN throws
  // from the journal writer, so the savepoint unwinds that asset and the run
  // reports glFailed. Throwing here instead would answer GENERIC_FAILURE where
  // the live call answers `ok` with a count — a dry run diverging from the live
  // call in the one place the caller is relying on it.
  let expense: CachedSystemAccount;
  let accumulated: CachedSystemAccount;
  try {
    expense = await getSystemAccount('depreciation_expense', companyId);
    accumulated = await getSystemAccount('accumulated_depreciation', companyId);
  } catch {
    return {
      journals: [],
      writesWithoutJournal: plan.postable.map((row) => ({
        id: row.assetId,
        reason: 'gl_accounts_not_configured',
        detail:
          'No system account is configured for depreciation_expense or '
          + 'accumulated_depreciation, so no journal can post. The live run would still write '
          + `the asset_period_ledger row for ${row.assetNumber} and then roll it back, reporting `
          + 'it in glFailed. Configure the accounts with update_gl_account first.',
      })),
    };
  }

  const byId = new Map(assets.map((a) => [String(a.id), a]));

  const journals: DryRunJournal[] = [];
  const writesWithoutJournal: DryRunSkip[] = [];
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
      method: toDepreciationMethod(a.depreciation_method),
      ...(a.disposal_date ? { disposalDate: fmtDate(a.disposal_date) } : {}),
    });
    // The live path posts NO JOURNAL at or below zero — but it still UPSERTs the
    // asset_period_ledger row, because postDualDepreciationToLedger writes the
    // subledger before it calls the journal writer. An asset fully depreciated
    // on policy while still carrying tax life is exactly that case. Dropping it
    // silently made the dry run report zero journals for a call that writes
    // rows: the parity break in the dangerous direction, and by the contract's
    // own words worse than no dry run at all.
    if (policy.monthlyDep <= 0) {
      writesWithoutJournal.push({
        id: row.assetId,
        reason: 'subledger_row_only_no_journal',
        detail:
          `${row.assetNumber} has no policy depreciation left for this period, so NO GL journal `
          + 'would post — but the live run still writes its asset_period_ledger row, carrying the '
          + 'tax figures and the closing carrying amounts. This call is not a no-op for it.',
      });
      continue;
    }

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
  return { journals, writesWithoutJournal };
}
