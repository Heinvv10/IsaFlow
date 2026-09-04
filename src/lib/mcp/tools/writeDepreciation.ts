/**
 * `run_depreciation` — the monthly depreciation run, over MCP.
 *
 * This is an EXTEND, not a wrap: the logic was inline SQL inside
 * `pages/api/accounting/run-depreciation.ts` and now lives in
 * `services/items/depreciationRunService`, which the route calls too. One
 * implementation, two callers.
 *
 * THE WRITE BOUNDARY IS THE ONLY THING THAT MATTERS IN THIS FILE.
 * `planDepreciationRun` writes nothing, so every refusal it can produce is
 * answered with `toolError` BEFORE the first write. Once
 * `executeDepreciationRun` has been called, nothing is caught: the registry's
 * savepoint rolls back on a THROW and not on a returned error, so a
 * write-then-toolError would COMMIT the journals already posted and free the
 * idempotency key for a retry that posts them again.
 */
import type { McpTool } from '../types';
import {
  loadDepreciationAssets,
  planDepreciationRun,
  previewDepreciationJournals,
  executeDepreciationRun,
  defaultPeriodDate,
} from '@/modules/accounting/services/items/depreciationRunService';
import { MUTATION_ARG_SCHEMA, type DryRunResult } from '../contracts';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const runDepreciationTool: McpTool = {
  name: 'run_depreciation',
  description:
    'Runs the monthly depreciation for every eligible fixed asset in one period, writing the per-asset result to the fixed asset subledger and posting DR Depreciation Expense / CR Accumulated Depreciation to the general ledger. '
    + 'period_date is the LAST DAY of the period being depreciated (YYYY-MM-DD) and defaults to the last day of the current month. It decides the journal date, the journal entry number (DEP-<asset number>-YYYY-MM) and the subledger period, so a run for an earlier month posts into THAT month. '
    + 'ALWAYS CALL IT WITH dry_run: true FIRST. The dry run returns the journals that would post, in full, with the account codes and the amounts on both legs, and the assets that would be skipped with the reason for each. It writes nothing and does not consume the idempotency key. dry_run defaults to FALSE: a call without it POSTS. '
    + 'It refuses BEFORE writing anything when no fiscal period covers period_date, when that period is closed or locked, or when no asset would post. Those are different refusals because the remedies differ — create the fiscal year, re-open the period, or look at why every asset was skipped. '
    + 'An asset is skipped, not failed, when it is not in service (disposed, retired), has no purchase price, is marked below the capitalisation threshold, has no useful life on itself or its category, or already has an unreversed journal for this period. Re-running a period is therefore safe: every asset already posted is skipped by entry number. '
    + 'READ glFailed ON THE REPLY. It counts assets whose subledger row and journal were rolled back together as a unit while the rest of the run committed. A success with glFailed above zero is a PARTIAL run and accumulated depreciation is understated by those assets until the cause is fixed and the period re-run. '
    + 'It depreciates on the ACCOUNTING (IAS 16) policy only in the general ledger; the SARS wear-and-tear figure is computed and stored in the subledger but is not journalised. It does not create assets, does not dispose of them, and does not reclassify any account. '
    + 'Call reconcile_fixed_assets afterwards to check the register against the ledger — on these books they do not agree, and a depreciation run does not make them.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      period_date: {
        type: 'string',
        format: 'date',
        description: 'Last day of the period to depreciate, YYYY-MM-DD. Defaults to the last day of the current month.',
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['period_date'] });
    if (bad) return bad;

    const periodDate = strArg(args, 'period_date') ?? defaultPeriodDate();
    const dryRun = args.dry_run === true;

    // ── PRE-WRITE. Everything below refuses with toolError; nothing has been
    // written and there is nothing to unwind.
    const assets = await loadDepreciationAssets(ctx.companyId);
    const plan = await planDepreciationRun(ctx.companyId, periodDate, assets);

    if (plan.blocker) return toolError(plan.blocker.detail);
    if (plan.postable.length === 0) {
      // "There is no asset register" and "every asset was skipped" are
      // different facts and lead to different next steps, so they are
      // different messages rather than one with an empty reason list.
      return toolError(
        plan.rows.length === 0
          ? `Nothing to depreciate for ${periodDate}: this company has no fixed assets on the register. `
            + 'Capture the assets before running depreciation.'
          : `Nothing to depreciate for ${periodDate}: all ${plan.rows.length} assets were skipped `
            + `(${[...new Set(plan.rows.map((r) => r.skipReason))].join(', ')}). `
            + 'A run that posted nothing and reported success would read as a completed period.',
      );
    }

    const skipped = plan.rows
      .filter((r) => r.skipReason !== null)
      .map((r) => ({
        id: r.assetId,
        reason: r.skipReason as string,
        ...(r.skipDetail === null ? {} : { detail: r.skipDetail }),
      }));

    if (dryRun) {
      const journals = await previewDepreciationJournals(ctx.companyId, plan, assets);
      const result: DryRunResult = {
        dryRun: true,
        journals,
        skipped,
        effects: [],
        journalsTotal: journals.length,
        truncated: false,
      };
      // wroteNothing frees the idempotency key. Without it the preview is
      // stored under it and the real call — same intent, same key — is served
      // the preview forever.
      return { ...ok(result), wroteNothing: true };
    }

    // ── WRITE. No try/catch from here: a returned error would release the
    // savepoint, committing the journals already posted, and free the key for a
    // retry that posts them a second time.
    const run = await executeDepreciationRun(ctx.companyId, ctx.userId, plan, assets);

    return ok({
      period_date: run.periodDate,
      yyyymm: run.yyyymm,
      fiscal_period_id: plan.fiscalPeriodId,
      processed: run.processed,
      skipped: run.skipped,
      glFailed: run.glFailed,
      total: run.total,
      results: run.results.map((r) => ({
        asset_number: r.assetNumber,
        policy_depreciation: r.policyDep,
        tax_depreciation: r.taxDep,
        journal_entry_id: r.entryId,
      })),
      skipped_assets: skipped,
    });
  },
};
