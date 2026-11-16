/**
 * The facts a bank-rule sweep resolves ONCE for every auto-post rule's target account, moved verbatim out of
 * bankRulesMatchingService (its 300-line cap): s17(2)(a) denial flags, account names (non-supply guard), the bank
 * contra flags and the AP/AR control accounts.
 */

import { fetchVatDenialFlags } from '../gl/inputVatDenial';
import { fetchAccountNames } from '../gl/nonSupplyVatGuard';
import { fetchBankContraFlags } from '../gl/bankContraVat';
import { contactControlAccountIds } from './contactControlGuard';

export async function fetchRuleAccountFacts(companyId: string, autoCreateRules: Record<string, unknown>[]) {
  // One query for every rule's target account. A sweep posts hundreds of
  // lines against a handful of accounts, so resolving the s17(2)(a) denial
  // inside autoPostRuleLine would be one redundant SELECT per transaction.
  const ruleAccountIds = autoCreateRules
    .map((r) => (r.gl_account_id ? String(r.gl_account_id) : ''))
    .filter(Boolean);
  const [ruleAccountVatDenied, ruleAccountNames, ruleAccountIsBank, ruleAccountIsControl] = await Promise.all([
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
    contactControlAccountIds(companyId, ruleAccountIds),
  ]);
  return { ruleAccountVatDenied, ruleAccountNames, ruleAccountIsBank, ruleAccountIsControl };
}
