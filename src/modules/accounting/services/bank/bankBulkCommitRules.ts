/**
 * The bulk statement commit's optional rule pass (`applyBankRules`), moved out of
 * pages/api/accounting/bank-transactions-bulk-commit.ts for its line cap, unchanged.
 */
import { log } from '@/lib/logger';
import { withSavepoint } from '@/lib/neon';
import { applyRules as applyBankRulesService } from './bankRulesService';

/** The rule pass after one file's lines are imported. A failure is logged and swallowed: the import still lands. */
export async function applyRulesAfterBulkFile(
  companyId: string, bankAccountId: string, userId: string, filename: string,
): Promise<{ applied: number; skippedLocked: number }> {
  try {
    // In a savepoint: this catch swallows a rule-pass failure so the import still lands, and withAuth COMMITs
    // the 200 — without it the lines the pass posted before it failed were committed behind `appliedRules: 0`.
    // A line held by a peer (e.g. the journal number lock past its 5 s bound) is not a failure: applyRules skips
    // it and counts it in `autoPostSkippedLocked`, which reaches the response below.
    const ruleResult = await withSavepoint('bulk_commit_rules', () => applyBankRulesService(
      companyId,
      bankAccountId,
      userId,
    ));
    return { applied: ruleResult.applied, skippedLocked: ruleResult.autoPostSkippedLocked ?? 0 };
  } catch (err) {
    log.warn('Failed to apply bank rules after bulk commit file', {
      error: err, filename,
    }, 'accounting-api');
    return { applied: 0, skippedLocked: 0 };
  }
}
