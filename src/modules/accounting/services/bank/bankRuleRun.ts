/**
 * A bank-rule auto-post run's work, read ONCE before its first journal: every auto-create rule's candidates (its own
 * query and cap, brk-numrace L1 — a rule no longer re-reads past its window) with the rule's posting context.
 *
 * ORDERED LAZY (core/numberYearLocks.ts): applyRules walks the items by (the line's year — its journal is dated the
 * bank line's date — then line id, then rule priority), skipping a line an earlier item of the run posted. So the
 * run reaches its year keys ascending, each taken by the line's own posting after its row lock, where a single
 * allocation takes it; a line two rules match is still offered to the higher-priority rule first.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { findMatchingTxs, MAX_RULE_CANDIDATES, type RuleAllocType } from './bankRulesMatchingHelpers';
import { rulePattern } from './bankRulesSuggestionPass';
import { journalYearOf, orderByPredictedYears } from '../core/numberYearLocks';

type Row = Record<string, unknown>;

/** One rule's posting context, resolved once per run. */
export interface RuleContext {
  rule: Row; ruleName: string; allocType: RuleAllocType;
  ruleGlAccountId: string | null; ruleSupplierId: string | null;
  apAccountId: string | null; arAccountId: string | null; supplierName: string | null; customerName: string | null;
}

export interface RuleRun {
  /** (rule, line) pairs in processing order. */
  work: { ctx: RuleContext; tx: Row }[];
  /** Rules that matched more than one run may take. */
  truncatedRules: number;
}

const byId = (a: Row, b: Row) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

async function contextOf(companyId: string, rule: Row): Promise<RuleContext | null> {
  const ruleName = String(rule.rule_name);
  const ruleGlAccountId = rule.gl_account_id ? String(rule.gl_account_id) : null;
  const ruleSupplierId = rule.supplier_id ? String(rule.supplier_id) : null;
  const ruleClientId = rule.client_id ? String(rule.client_id) : null;
  // Account/bank rules use rule.gl_account_id as the contra; supplier rules post to AP, customer rules to AR.
  const allocType: RuleAllocType = ruleSupplierId ? 'supplier' : ruleClientId ? 'customer' : 'account';
  if (allocType === 'account' && !ruleGlAccountId) {
    log.warn('Skipping auto-create rule with no contra account', { ruleId: rule.id, ruleName }, 'accounting');
    return null;
  }
  const ctx: RuleContext = { rule, ruleName, allocType, ruleGlAccountId, ruleSupplierId,
    apAccountId: null, arAccountId: null, supplierName: null, customerName: null };
  if (allocType === 'supplier' && ruleSupplierId) {
    ctx.apAccountId = await getSystemAccountId('payable', companyId);
    const rows = (await sql`SELECT name FROM suppliers
      WHERE id = ${ruleSupplierId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    ctx.supplierName = rows[0]?.name ? String(rows[0].name) : `Supplier #${ruleSupplierId}`;
  } else if (allocType === 'customer' && ruleClientId) {
    ctx.arAccountId = await getSystemAccountId('receivable', companyId);
    const rows = (await sql`SELECT name FROM customers
      WHERE id = ${ruleClientId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    ctx.customerName = rows[0]?.name ? String(rows[0].name) : `Customer #${ruleClientId}`;
  }
  return ctx;
}

/** `autoCreateRules` in priority order. Refuses (400) a run whose lines span more than 20 years, before any write. */
export async function prepareRuleRun(
  companyId: string, bankAccountId: string, autoCreateRules: readonly Row[],
): Promise<RuleRun> {
  const pairs: { ctx: RuleContext; tx: Row; rank: number }[] = [];
  let truncatedRules = 0;
  for (const [rank, rule] of autoCreateRules.entries()) {
    const ctx = await contextOf(companyId, rule);
    if (!ctx) continue;
    // findMatchingTxs fetches one row past the cap; the extra row is the signal that the rule matched more.
    const txs = await findMatchingTxs(companyId, bankAccountId, String(rule.match_field), rulePattern(rule));
    if (txs.length > MAX_RULE_CANDIDATES) truncatedRules++;
    for (const tx of txs.slice(0, MAX_RULE_CANDIDATES)) pairs.push({ ctx, tx, rank });
  }
  pairs.sort((a, b) => byId(a.tx, b.tx) || a.rank - b.rank);
  const work = orderByPredictedYears(pairs, (p) => [journalYearOf(p.tx.transaction_date as string | Date)]);
  return { work: work.map(({ ctx, tx }) => ({ ctx, tx })), truncatedRules };
}

/** Every year the rules' candidates can post in — the same read and cap (bulk-commit's request-wide keys). */
export async function ruleCandidateYears(
  companyId: string, bankAccountId: string, autoCreateRules: readonly Row[],
): Promise<{ years: number[]; lineIds: string[] }> {
  const ids = new Map<string, number>();
  for (const rule of autoCreateRules) {
    if (!rule.supplier_id && !rule.client_id && !rule.gl_account_id) continue;
    const txs = await findMatchingTxs(companyId, bankAccountId, String(rule.match_field), rulePattern(rule));
    for (const tx of txs.slice(0, MAX_RULE_CANDIDATES)) ids.set(String(tx.id), journalYearOf(tx.transaction_date as string | Date));
  }
  return { years: [...ids.values()], lineIds: [...ids.keys()].sort() };
}
