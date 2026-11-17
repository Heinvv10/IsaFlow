/**
 * The rule sweep's transfer pre-lock (WP2 row 5 round 2): before the sweep's first journal, the lines its TRANSFER rules
 * will post (an account rule onto ANOTHER bank account that is not AP/AR control) and their pairs, in the single
 * path's line -> pair order (transferSweepPrelock). Only a rule that survives those checks AND matches at least one
 * candidate takes anything, so a sweep whose transfer rule matches nothing never blocks a person's transfer on that
 * pair. The candidate reads are returned for the sweep to reuse (no second query per rule).
 */
import { fmtDate } from '@/lib/fmtDate';
import { findMatchingTxs, getPeriodStatusForDate, MAX_RULE_CANDIDATES } from './bankRulesMatchingHelpers';
import { rulePattern } from './bankRulesSuggestionPass';
import { preLockSweepTransfers } from './transferSweepPrelock';

export interface RuleTransferPrelock {
  /** rule id -> its candidate rows (findMatchingTxs, one past the cap), for every transfer rule. */
  matches: Map<string, Record<string, unknown>[]>;
  /** Candidate lines whose line or pair another request holds: skipped as locked. */
  contended: Set<string>;
}

export async function preLockRuleTransfers(
  companyId: string, bankAccountId: string, bankGlAccountId: string, rules: readonly Record<string, unknown>[],
  isBank: ReadonlyMap<string, boolean>, isControl: ReadonlySet<string>,
): Promise<RuleTransferPrelock> {
  const matches = new Map<string, Record<string, unknown>[]>();
  const lines: { id: string; contra: string }[] = [];
  const periodOpen = new Map<string, boolean>(); // one period read per date
  for (const rule of rules) {
    const acct = rule.gl_account_id ? String(rule.gl_account_id) : '';
    if (!acct || rule.supplier_id || rule.client_id || !isBank.get(acct) || isControl.has(acct.toLowerCase())
      || acct.toLowerCase() === bankGlAccountId.toLowerCase()) continue;
    const found = await findMatchingTxs(companyId, bankAccountId, String(rule.match_field), rulePattern(rule));
    matches.set(String(rule.id), found);
    for (const tx of found.slice(0, MAX_RULE_CANDIDATES)) {
      // #1494 brk 4: a line the transfer line will skip anyway (its date in no open period — autoPostRuleTransferLine's
      // own pre-flight) takes no line or pair lock: it would hold them for the whole sweep for nothing.
      const date = fmtDate(tx.transaction_date as Date | string);
      if (!periodOpen.has(date)) periodOpen.set(date, (await getPeriodStatusForDate(companyId, date)) === 'open');
      if (periodOpen.get(date)) lines.push({ id: String(tx.id), contra: acct });
    }
  }
  const { contended } = await preLockSweepTransfers(companyId, lines);
  return { matches, contended };
}
