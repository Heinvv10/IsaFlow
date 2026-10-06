/**
 * The bank-rule auto-post run's up-front year lock (core/numberYearLocks.ts): each rule line's journal is dated
 * the bank line's date, so the run takes the journal key of every year its rules can match, ascending, before
 * its first journal. Read with the run's own query and cap; a superset of what the run posts, since a later rule's
 * re-read no longer sees an earlier rule's lines. Residual: a line committed into a NEW year between this read and
 * its rule's own read posts without its key taken up front.
 */
import { findMatchingTxs, MAX_RULE_CANDIDATES } from './bankRulesMatchingHelpers';
import { rulePattern } from './bankRulesSuggestionPass';
import { journalYearOf, lockNumberYears } from '../core/numberYearLocks';

export async function lockRuleRunYears(
  companyId: string,
  bankAccountId: string,
  autoCreateRules: readonly Record<string, unknown>[],
): Promise<void> {
  const years: number[] = [];
  for (const rule of autoCreateRules) {
    const txs = await findMatchingTxs(companyId, bankAccountId, String(rule.match_field), rulePattern(rule));
    for (const tx of txs.slice(0, MAX_RULE_CANDIDATES)) years.push(journalYearOf(tx.transaction_date as string | Date));
  }
  await lockNumberYears(companyId, years);
}
