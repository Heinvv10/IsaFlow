/**
 * bank-transactions-bulk-commit's journal-posting steps, out of the route (300-line ceiling).
 *
 * The request posts in TWO passes in one transaction: the import's auto-post sweep, then the rule pass. Each walks its
 * own lines ordered lazy (core/numberYearLocks.ts), but the sweep can end holding a later year than the rule pass then
 * needs (brk-numrace M1). So the request takes its keys up front — the one place it does:
 *
 *   `planBulkCommitYears` (before the PAYG debit; reads only): the rule candidates that already exist (bankRuleRun's
 *   read and cap); a request whose statement + candidate years exceed 20 is refused (400) and charges nothing.
 *
 *   `lockBulkCommitYears` (AFTER the debit, outside the route's refund block: a held key is a 503 whose rollback
 *   undoes the debit). Every lock base takes before a journal number is taken here before the keys:
 *     1. the PAYG wallet — by the debit itself; withFlowMeter routes lock it, then number, as base bulk-commit did;
 *     2. the suggestion pass over the existing lines (the rule pass's first statement, which row-locks every line
 *        whose suggestion changes) — run here, so a single allocator of one of them is waited for, not cycled with;
 *     3. the existing rule candidates' bank lines (lockBankTransactionForUpdate), in id order, each in its own
 *        savepoint — a line a peer holds past 5 s is left out of the pass and reported held (brk-numrace G);
 *     4. every statement + candidate year's key, ascending (lockNumberYears).
 * The import's own lines are this transaction's rows: nothing else can lock them. After the keys a rule line locks
 * only rows it already holds or its own new ones before its journal, and after its journal what base locks after it.
 * Residual: a line committed, or re-suggested, by a peer between these reads and the rule pass is locked after them.
 *
 * `runBulkCommitRulePass`: the pass in a savepoint, its failure swallowed so the import still lands.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isHeldRowError } from '@/lib/lockTimeout';
import { assertRunYears, journalYearOf, lockNumberYears } from '../core/numberYearLocks';
import { applyRules } from './bankRulesService';
import { ruleCandidateYears } from './bankRuleRun';
import { applySuggestionRules } from './bankRulesSuggestionPass';
import { lockBankTransactionForUpdate } from './bankTxLock';

type Row = Record<string, unknown>;

export interface BulkCommitYearPlan { years: number[]; lineIds: string[]; suggestionRules: Row[] }

/** Reads only. Refuses (400) more than 20 statement + candidate years, before the debit. */
export async function planBulkCommitYears(
  companyId: string, bankAccountId: string, statementDates: readonly string[], applyBankRules: boolean,
): Promise<BulkCommitYearPlan> {
  const rules = applyBankRules ? (await sql`
    SELECT * FROM bank_categorisation_rules
    WHERE company_id = ${companyId}::UUID AND is_active = true
    ORDER BY priority ASC
  `) as Row[] : [];
  const autoCreate = rules.filter((r) => Boolean(r.auto_create_entry));
  const candidates = autoCreate.length > 0
    ? await ruleCandidateYears(companyId, bankAccountId, autoCreate) : { years: [], lineIds: [] };
  const years = [...statementDates.map((d) => journalYearOf(d)), ...candidates.years];
  assertRunYears(years);
  return { years, lineIds: candidates.lineIds, suggestionRules: rules.filter((r) => !r.auto_create_entry) };
}

export interface BulkCommitLocks {
  /** Candidate lines a peer held past their lock's bound (left out of the rule pass). */
  held: Set<string>;
  /** Existing lines whose suggestion step 2 changed (the rule pass no longer sees them as changes). */
  presuggested: number;
}

export async function lockBulkCommitYears(
  companyId: string, bankAccountId: string, plan: BulkCommitYearPlan,
): Promise<BulkCommitLocks> {
  let presuggested = 0;
  if (plan.suggestionRules.length > 0) {
    try {
      presuggested = (await withSavepoint('bulk_commit_suggest',
        () => applySuggestionRules(companyId, bankAccountId, plan.suggestionRules))).length;
    } catch (err) {
      // As the rule pass's own failure: logged, and the import still lands; the rule pass runs this step again.
      log.warn('Bulk commit suggestion pre-pass failed', { error: err }, 'accounting-api');
    }
  }
  const held = new Set<string>();
  for (const [n, id] of plan.lineIds.entries()) {
    try {
      await withSavepoint(`bulk_commit_claim_${n}`, () => lockBankTransactionForUpdate(companyId, id));
    } catch (err) {
      if (!isHeldRowError(err)) throw err;
      held.add(id);
    }
  }
  await lockNumberYears(companyId, plan.years);
  return { held, presuggested };
}

export interface RulePassOutcome { applied: number; skippedLocked: number; warnings: string[] }

export async function runBulkCommitRulePass(
  companyId: string, bankAccountId: string, userId: string, filename: string, locks: BulkCommitLocks,
): Promise<RulePassOutcome> {
  try {
    const r = await withSavepoint('bulk_commit_rules',
      () => applyRules(companyId, bankAccountId, userId, undefined, { heldLineIds: locks.held }));
    return { applied: r.applied + locks.presuggested, skippedLocked: r.autoPostSkippedLocked ?? 0, warnings: [] };
  } catch (err) {
    log.warn('Failed to apply bank rules after bulk commit file', { error: err, filename }, 'accounting-api');
    return { applied: locks.presuggested, skippedLocked: 0, warnings: isHeldRowError(err)
      ? ['Bank rules were not applied: another request is posting for this company. Apply the rules again in a moment.']
      : [] };
  }
}
