/**
 * The auto-post half of `applyRules`: every `auto_create_entry` rule, every
 * candidate it matches, one controlled allocation per line, and the tally of
 * what each line came to. Split out of `bankRulesMatchingService.ts` to keep
 * that file under the 300-line cap; the suggestion pass and the final
 * "remaining" count stay there.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchVatDenialFlags } from '../gl/inputVatDenial';
import { fetchAccountNames } from '../gl/nonSupplyVatGuard';
import { fetchBankContraFlags } from '../gl/bankContraVat';
import { MAX_BANK_LINES_PER_REQUEST, MAX_RULE_SWEEP_ATTEMPTS_PER_REQUEST } from '@/lib/limits/authorityHoldLimits';
import type { RuleApplyResult } from '../../types/bank.types';
import { toSqlPattern, findMatchingTxs, MAX_RULE_CANDIDATES, type RuleAllocType } from './bankRulesMatchingHelpers';
import { BankTransactionLockTimeoutError } from './bankTxLock';
import { autoPostRuleLine } from './bankRuleAutoPostLine';
import type { AutoPostRefusal } from './bankRuleAutoPostRefusal';
import { approvalRequiredForLine, dateRefusal, loadLockdownFacts } from './bankRulesAutoPostPreflight';

type Row = Record<string, unknown>;
/** Distinct `refused` reasons carried back per run; past this the count still climbs, the list does not. */
const MAX_REFUSAL_REASONS = 10;

export type AutoPostCounters = Required<Pick<RuleApplyResult,
  | 'autoPostSkippedClosedPeriod' | 'autoPostSkippedNoPeriod' | 'autoPostSkippedRaced' | 'autoPostSkippedLocked' | 'autoPostTruncatedRules'
  | 'autoPostSkippedApprovalRequired' | 'autoPostSkippedBeneficiaryUnverified' | 'autoPostSkippedLockdown'
  | 'autoPostSkippedVatPeriodFiled' | 'autoPostSkippedPermissionDenied' | 'autoPostSkippedRefused'
  | 'autoPostRefusalReasons' | 'autoPostVatDenied' | 'autoPostNonSupply' | 'autoPostDeferred'>>;

export function emptyAutoPostCounters(): AutoPostCounters {
  return {
    autoPostSkippedClosedPeriod: 0, autoPostSkippedNoPeriod: 0, autoPostSkippedRaced: 0, autoPostSkippedLocked: 0, autoPostTruncatedRules: 0,
    autoPostSkippedApprovalRequired: 0, autoPostSkippedBeneficiaryUnverified: 0, autoPostSkippedLockdown: 0,
    autoPostSkippedVatPeriodFiled: 0, autoPostSkippedPermissionDenied: 0, autoPostSkippedRefused: 0,
    autoPostRefusalReasons: [], autoPostVatDenied: 0, autoPostNonSupply: 0, autoPostDeferred: 0,
  };
}

/** Which counter a refusal lands in. Exhaustive: a new refusal kind is a type error here until it is counted. */
function countRefusal(counters: AutoPostCounters, refusal: AutoPostRefusal): void {
  switch (refusal.kind) {
    case 'approval_required': counters.autoPostSkippedApprovalRequired++; return;
    case 'beneficiary_unverified': counters.autoPostSkippedBeneficiaryUnverified++; return;
    case 'closed_period': counters.autoPostSkippedClosedPeriod++; return;
    case 'no_period': counters.autoPostSkippedNoPeriod++; return;
    case 'lockdown': counters.autoPostSkippedLockdown++; return;
    case 'vat_period_filed': counters.autoPostSkippedVatPeriodFiled++; return;
    case 'permission_denied': counters.autoPostSkippedPermissionDenied++; return;
    case 'refused':
      counters.autoPostSkippedRefused++;
      if (counters.autoPostRefusalReasons.length < MAX_REFUSAL_REASONS
        && !counters.autoPostRefusalReasons.includes(refusal.reason)) counters.autoPostRefusalReasons.push(refusal.reason);
      return;
  }
}

export async function sweepAutoPostRules(companyId: string, bankAccountId: string, userId: string,
  autoCreateRules: Row[]): Promise<{ entries: RuleApplyResult['entries']; applied: number; counters: AutoPostCounters }> {
  const entries: RuleApplyResult['entries'] = [];
  const counters = emptyAutoPostCounters();
  let applied = 0;
  // Every line runs inside this request's transaction, which holds the company
  // authority key from its first permission check to COMMIT; the bounds keep the
  // hold under the 2.5 s budget (authorityHoldLimits.ts). Past either, the rest
  // of the candidates are COUNTED as deferred, not attempted: the caller runs
  // again, and the still-imported lines match again.
  let attempted = 0;
  const atCapacity = () => applied >= MAX_BANK_LINES_PER_REQUEST || attempted >= MAX_RULE_SWEEP_ATTEMPTS_PER_REQUEST;
  const company = await loadLockdownFacts(companyId);
  // The person's permission does not change within the request: after one
  // permission refusal every remaining line is counted, none attempted.
  let permissionDenied: AutoPostRefusal | null = null;
  const refuse = (tx: Row, ruleName: string, refusal: AutoPostRefusal) => {
    // Logged per line: the counters say how many, this says which and why.
    log.warn('Bank rule auto-post refused for a line', { companyId, bankTxId: String(tx.id), ruleName, ...refusal }, 'accounting');
    countRefusal(counters, refusal);
  };

  // One query for every rule's target account. A sweep posts hundreds of
  // lines against a handful of accounts, so resolving the s17(2)(a) denial
  // inside autoPostRuleLine would be one redundant SELECT per transaction.
  const ruleAccountIds = autoCreateRules.map((r) => (r.gl_account_id ? String(r.gl_account_id) : '')).filter(Boolean);
  const [ruleAccountVatDenied, ruleAccountNames, ruleAccountIsBank] = await Promise.all([
    fetchVatDenialFlags(companyId, ruleAccountIds),
    // The non-supply guard classifies on account NAME, so the batched branch
    // needs these for the same reason and on the same one-query-per-sweep
    // budget as the denial flags beside them.
    fetchAccountNames(companyId, ruleAccountIds),
    // A transfer rule stores its counterparty BANK in gl_account_id and so
    // arrives as an ordinary `account` line. The name guard cannot see that
    // — "FNB Cheque Account" reads like any other — so the subtype comes
    // along on the same budget.
    fetchBankContraFlags(companyId, ruleAccountIds),
  ]);

  for (const rule of autoCreateRules) {
    const pattern = toSqlPattern(String(rule.match_type), String(rule.match_pattern));
    const field = String(rule.match_field);
    const ruleName = String(rule.rule_name);
    const ruleGlAccountId = rule.gl_account_id ? String(rule.gl_account_id) : null;
    const ruleSupplierId = rule.supplier_id ? String(rule.supplier_id) : null;
    const ruleClientId = rule.client_id ? String(rule.client_id) : null;

    // Allocation shape from the rule: account/bank rules post to gl_account_id,
    // supplier and customer rules to the party through the controlled allocation.
    const allocType: RuleAllocType = ruleSupplierId ? 'supplier' : ruleClientId ? 'customer' : 'account';
    if (allocType === 'account' && !ruleGlAccountId) {
      log.warn('Skipping auto-create rule with no contra account', { ruleId: rule.id, ruleName }, 'accounting');
      continue;
    }

    const matchingTxs = await findMatchingTxs(companyId, bankAccountId, field, pattern);
    if (atCapacity()) { counters.autoPostDeferred += Math.min(matchingTxs.length, MAX_RULE_CANDIDATES); continue; }

    // Entity names lazily (only when needed), for the default description.
    let supplierName: string | null = null;
    let customerName: string | null = null;
    if (allocType === 'supplier' && ruleSupplierId) {
      const supRows = (await sql`SELECT name FROM suppliers WHERE id = ${ruleSupplierId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
      supplierName = supRows[0]?.name ? String(supRows[0].name) : `Supplier #${ruleSupplierId}`;
    } else if (allocType === 'customer' && ruleClientId) {
      const custRows = (await sql`SELECT name FROM customers WHERE id = ${ruleClientId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
      customerName = custRows[0]?.name ? String(custRows[0].name) : `Customer #${ruleClientId}`;
    }

    // findMatchingTxs fetches one row past the cap; the extra row is the
    // signal that this rule matched more than one run may take.
    const capped = matchingTxs.slice(0, MAX_RULE_CANDIDATES);
    if (matchingTxs.length > MAX_RULE_CANDIDATES) counters.autoPostTruncatedRules++;

    // Locked in id order, not the candidate query's date order: every
    // allocation path holds its row lock to the end of the request, so two
    // runs touching the same rows in opposite orders deadlock (40P01).
    const orderedTxs = [...capped].sort((a, b) => {
      const x = String(a.id), y = String(b.id);
      return x < y ? -1 : x > y ? 1 : 0;
    });

    // A supplier rule names ONE supplier: once its beneficiary is refused, every
    // other line of the rule would be too, so they are counted, not attempted.
    let ruleBeneficiary: AutoPostRefusal | null = null;
    for (const [index, tx] of orderedTxs.entries()) {
      const known = permissionDenied ?? ruleBeneficiary ?? dateRefusal(tx, company);
      if (known) { refuse(tx, ruleName, known); continue; }
      if (await approvalRequiredForLine(tx.amount)) { refuse(tx, ruleName, { kind: 'approval_required' }); continue; }
      if (atCapacity()) { counters.autoPostDeferred += orderedTxs.length - index; break; }
      attempted++;
      let outcome;
      try {
        // Savepoint per line: a lock timeout is a REAL 55P03, which aborts
        // the transaction — without the savepoint the next candidate's
        // first statement raises 25P02 and the whole run dies after one skip.
        // A REFUSED line needs nothing from it: allocateTransaction's own
        // adapter savepoint has already unwound the intent it prepared.
        outcome = await withSavepoint('rule_autopost_line', () => autoPostRuleLine({
          companyId, userId, tx, rule, ruleName, allocType, ruleGlAccountId,
          ruleGlAccountVatDenied: ruleGlAccountId ? ruleAccountVatDenied.get(ruleGlAccountId) ?? false : false,
          // `?? null` and never undefined: autoPostRuleLine reads undefined
          // as "the caller did not resolve this" and falls back to a
          // per-line lookup, which is the safe reading but not the one we
          // want when the sweep DID resolve it and the account has no name.
          ruleGlAccountName: ruleGlAccountId ? ruleAccountNames.get(ruleGlAccountId) ?? null : null,
          // No `?? false`. `bankContraVat` states that absent from the map
          // means "not asked about", never "not a bank", and coalescing here
          // would skip the guard instead of falling back to the per-line
          // lookup — the same reason `ruleGlAccountName` above uses `?? null`
          // for its OWN meaning of absent rather than borrowing this one.
          ruleGlAccountIsBank: ruleGlAccountId ? ruleAccountIsBank.get(ruleGlAccountId) : false,
          supplierName, supplierId: ruleSupplierId, customerName, customerId: ruleClientId,
        }));
      } catch (lineErr) {
        // Another request is holding this row. One contended transaction must
        // not abort a run that has already posted for earlier ones — the
        // route's catch would 400 while withAuth still COMMITted them.
        // Counted and retryable; anything else is a real failure.
        if (!(lineErr instanceof BankTransactionLockTimeoutError)) throw lineErr;
        counters.autoPostSkippedLocked++;
        continue;
      }
      if (outcome.kind === 'raced') { counters.autoPostSkippedRaced++; continue; }
      if (outcome.kind !== 'posted') {
        refuse(tx, ruleName, outcome);
        if (outcome.kind === 'permission_denied') permissionDenied = outcome;
        if (outcome.kind === 'beneficiary_unverified') ruleBeneficiary = outcome;
        continue;
      }

      entries.push({ bankTxId: String(tx.id), ruleName, journalEntryId: outcome.journalEntryId });
      if (outcome.vatDenied) counters.autoPostVatDenied++;
      if (outcome.nonSupplyCoerced) counters.autoPostNonSupply++;
      applied++;
    }
  }
  return { entries, applied, counters };
}
