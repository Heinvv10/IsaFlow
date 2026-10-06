/**
 * The bank-rule auto-post run's candidates, read ONCE before its first journal, and its up-front year lock
 * (core/numberYearLocks.ts). Each rule line's journal is dated the bank line's date.
 *
 * The run posts exactly these sets (round 2, brk-numrace L1): each auto-create rule's own query and cap, id-sorted,
 * read here, and applyRules walks them, skipping a line an earlier rule of the run already posted. Before, each rule
 * re-read its candidates in the loop, so once an earlier rule had consumed lines inside a later rule's 500-line
 * window the later re-read reached lines (and years) this read never saw. The lines are claimed with the
 * bank-line lock (id order) before the year keys, the order a single allocation takes them.
 */
import { findMatchingTxs, MAX_RULE_CANDIDATES } from './bankRulesMatchingHelpers';
import { rulePattern } from './bankRulesSuggestionPass';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { claimRowsThenLockYears, journalYearOf } from '../core/numberYearLocks';

type Row = Record<string, unknown>;

export interface RuleRun {
  /** Each auto-create rule's candidates, id-sorted, capped — what the run may post for it. */
  candidates: Map<Row, Row[]>;
  /** Rules that matched more than one run may take. */
  truncatedRules: number;
}

const byId = (a: Row, b: Row) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/** Every year the rules' candidates can post in — read with prepareRuleRun's own query and cap (bulk-commit). */
export async function ruleCandidateYears(
  companyId: string, bankAccountId: string, autoCreateRules: readonly Row[],
): Promise<number[]> {
  const run = await readRuleCandidates(companyId, bankAccountId, autoCreateRules);
  return [...run.candidates.values()].flat().map((tx) => journalYearOf(tx.transaction_date as string | Date));
}

async function readRuleCandidates(
  companyId: string, bankAccountId: string, autoCreateRules: readonly Row[],
): Promise<RuleRun> {
  const candidates = new Map<Row, Row[]>();
  let truncatedRules = 0;
  for (const rule of autoCreateRules) {
    // A rule applyRules will skip (an account rule with no contra) claims nothing.
    if (!rule.supplier_id && !rule.client_id && !rule.gl_account_id) continue;
    // findMatchingTxs fetches one row past the cap; the extra row is the signal that the rule matched more.
    const txs = await findMatchingTxs(companyId, bankAccountId, String(rule.match_field), rulePattern(rule));
    if (txs.length > MAX_RULE_CANDIDATES) truncatedRules++;
    candidates.set(rule, txs.slice(0, MAX_RULE_CANDIDATES).sort(byId));
  }
  return { candidates, truncatedRules };
}

export async function prepareRuleRun(
  companyId: string,
  bankAccountId: string,
  autoCreateRules: readonly Row[],
): Promise<RuleRun> {
  const { candidates, truncatedRules } = await readRuleCandidates(companyId, bankAccountId, autoCreateRules);
  const lines = new Map<string, Row>();
  for (const txs of candidates.values()) for (const tx of txs) lines.set(String(tx.id), tx);
  await claimRowsThenLockYears(companyId,
    [...lines.values()].sort(byId).map((tx) => ({ id: String(tx.id), years: [journalYearOf(tx.transaction_date as string | Date)] })),
    (id) => lockBankTransactionForUpdate(companyId, id));
  return { candidates, truncatedRules };
}
