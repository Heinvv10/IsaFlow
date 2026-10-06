/**
 * bank-transactions-bulk-commit's journal-posting steps, out of the route (300-line ceiling).
 *
 * The request posts in TWO passes in one transaction: the import's auto-post sweep, then the rule pass. Each walks its
 * own lines ordered lazy (core/numberYearLocks.ts), but the sweep can end holding a later year than the rule pass then
 * needs (brk-numrace M1). So the request takes its keys up front — the one place it does — in this order:
 *
 *   1. read the rule candidates that already exist (bankRuleRun's read and cap) and refuse a request whose statement
 *      + candidate years exceed 20 (400, before any lock or write);
 *   2. claim those candidates' bank lines (lockBankTransactionForUpdate, the lock a single allocation takes first), in
 *      id order, each in its own savepoint — BEFORE any key, so a single allocator of one of them (row, then its
 *      number) is waited for, never cycled with (brk-numrace G). A line a peer holds past 5 s is left out of the pass
 *      and reported held;
 *   3. take every statement + candidate year's key, ascending (lockNumberYears).
 * The import's own lines are this transaction's rows: nothing else can lock them. What a rule line locks after its
 * row (bills, invoices, a contact) it locks after keys, exactly as on base, where the sweep's journal key came first.
 *
 * `runBulkCommitRulePass`: the pass in a savepoint, its failure swallowed so the import still lands.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isHeldRowError } from '@/lib/lockTimeout';
import { assertRunYears, journalYearOf, lockNumberYears } from '../core/numberYearLocks';
import { applyRules } from './bankRulesService';
import { ruleCandidateYears } from './bankRuleRun';
import { lockBankTransactionForUpdate } from './bankTxLock';

/** Returns the candidate lines a peer held past their lock's bound (left out of the rule pass). */
export async function lockBulkCommitYears(
  companyId: string, bankAccountId: string, statementDates: readonly string[], applyBankRules: boolean,
): Promise<Set<string>> {
  const rules = applyBankRules ? (await sql`
    SELECT * FROM bank_categorisation_rules
    WHERE company_id = ${companyId}::UUID AND is_active = true AND auto_create_entry = true
  `) as Record<string, unknown>[] : [];
  const candidates = rules.length > 0
    ? await ruleCandidateYears(companyId, bankAccountId, rules) : { years: [], lineIds: [] };
  const years = [...statementDates.map((d) => journalYearOf(d)), ...candidates.years];
  assertRunYears(years);
  const held = new Set<string>();
  for (const [n, id] of candidates.lineIds.entries()) {
    try {
      await withSavepoint(`bulk_commit_claim_${n}`, () => lockBankTransactionForUpdate(companyId, id));
    } catch (err) {
      if (!isHeldRowError(err)) throw err;
      held.add(id);
    }
  }
  await lockNumberYears(companyId, years);
  return held;
}

export interface RulePassOutcome { applied: number; skippedLocked: number; warnings: string[] }

export async function runBulkCommitRulePass(
  companyId: string, bankAccountId: string, userId: string, filename: string, heldLineIds: ReadonlySet<string>,
): Promise<RulePassOutcome> {
  try {
    const r = await withSavepoint('bulk_commit_rules',
      () => applyRules(companyId, bankAccountId, userId, undefined, { heldLineIds }));
    return { applied: r.applied, skippedLocked: r.autoPostSkippedLocked ?? 0, warnings: [] };
  } catch (err) {
    log.warn('Failed to apply bank rules after bulk commit file', { error: err, filename }, 'accounting-api');
    return { applied: 0, skippedLocked: 0, warnings: isHeldRowError(err)
      ? ['Bank rules were not applied: another request is posting for this company. Apply the rules again in a moment.']
      : [] };
  }
}
