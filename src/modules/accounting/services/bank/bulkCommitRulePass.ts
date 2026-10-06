/**
 * bank-transactions-bulk-commit's journal-posting steps, out of the route (300-line ceiling).
 *
 * `lockBulkCommitYears`, BEFORE the import (brk-numrace M1): the import's auto-post sweep numbers its journals, then
 * the rule pass numbers its own, all in the one request transaction. Each takes its years up front, but the second
 * did so AFTER the sweep's journal held a key — out of ascending order. So the route takes every year either can post
 * in first: the statement's dates (the sweep's lines are the import's own) and, when rules run, the rule pass's
 * candidate lines (bankRuleYearLocks). The later takes are re-entrant. The imported rows are this transaction's own,
 * so no row is claimed first; a rule candidate that already existed is claimed by the pass after these keys.
 *
 * `runBulkCommitRulePass`: the pass in a savepoint, its failure swallowed so the import still lands (withAuth COMMITs
 * the 200 — without the savepoint the lines posted before it failed were committed behind `appliedRules: 0`). A pass
 * whose year keys a peer held past 5 s posted nothing and says so; a held line inside it is skipped and counted.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isHeldRowError } from '@/lib/lockTimeout';
import { journalYearOf, lockNumberYears } from '../core/numberYearLocks';
import { applyRules } from './bankRulesService';
import { ruleCandidateYears } from './bankRuleYearLocks';

export async function lockBulkCommitYears(
  companyId: string, bankAccountId: string, statementDates: readonly string[], applyBankRules: boolean,
): Promise<void> {
  const rules = applyBankRules ? (await sql`
    SELECT * FROM bank_categorisation_rules
    WHERE company_id = ${companyId}::UUID AND is_active = true AND auto_create_entry = true
  `) as Record<string, unknown>[] : [];
  await lockNumberYears(companyId, [...statementDates.map((d) => journalYearOf(d)),
    ...(rules.length > 0 ? await ruleCandidateYears(companyId, bankAccountId, rules) : [])]);
}

export interface RulePassOutcome { applied: number; skippedLocked: number; warnings: string[] }

export async function runBulkCommitRulePass(
  companyId: string, bankAccountId: string, userId: string, filename: string,
): Promise<RulePassOutcome> {
  try {
    const r = await withSavepoint('bulk_commit_rules', () => applyRules(companyId, bankAccountId, userId));
    return { applied: r.applied, skippedLocked: r.autoPostSkippedLocked ?? 0, warnings: [] };
  } catch (err) {
    log.warn('Failed to apply bank rules after bulk commit file', { error: err, filename }, 'accounting-api');
    return { applied: 0, skippedLocked: 0, warnings: isHeldRowError(err)
      ? ['Bank rules were not applied: another request is posting for this company. Apply the rules again in a moment.']
      : [] };
  }
}
