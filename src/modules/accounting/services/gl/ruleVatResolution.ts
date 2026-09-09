/**
 * Which VAT code an UNATTENDED rule line actually posts with.
 *
 * Extracted from `autoPostRuleLine` so the decision can be tested without a
 * bank transaction, a journal, a period or a row lock. It was not testable
 * before, and a blind review found the consequence: the batched branch — the
 * one the sweep always takes in production — had no coverage at all, so
 * deleting the guard from it would have failed nothing.
 *
 * TWO GUARDS, TWO STATUTES, IN ORDER. `vat_input_denied` (s17(2)(a),
 * entertainment) is the narrower rule and runs first; the non-supply guard
 * runs only if the first did not already drop the claim. Both land on 'none',
 * so the order cannot change the posted code — it only decides which counter
 * reports it, and a denial mis-reported as a non-supply would send someone to
 * fix the wrong thing.
 *
 * BATCHED VS PER-LINE. A sweep posts hundreds of lines against a handful of
 * rule accounts, so it resolves the denial flag and the account name once and
 * passes both in. Batching requires BOTH: the non-supply guard classifies on
 * name, so a caller that passed the flag and forgot the name would silently
 * run only half the guard. An absent value therefore means "look it up per
 * line", never "skip the check".
 */

import { log } from '@/lib/logger';
import { applyVatDenial, resolveVatCodeForAccount } from './inputVatDenial';
import { isControlAccountSettlement } from './settlementVat';
import { applyNonSupplyGuard, resolveNonSupplyForAccount } from './nonSupplyVatGuard';
import type { NonSupplyContext } from './nonSupplyVatGuard';

export interface RuleVatInput {
  /** Only an account allocation has a contra account to judge. */
  allocType: string;
  companyId: string;
  requestedVatCode: string;
  glAccountId: string | null;
  /** Pre-resolved by the sweep; undefined means "look it up here". */
  ruleGlAccountVatDenied?: boolean;
  /** Pre-resolved by the sweep; undefined means "look it up here". */
  ruleGlAccountName?: string | null;
  denialContext: Record<string, unknown>;
  guardContext: Omit<NonSupplyContext, 'companyId'>;
}

export interface RuleVatDecision {
  vatCode: string;
  /** s17(2)(a) dropped the claim. */
  denied: boolean;
  /** No supply can arise on this account, so the claim was dropped. */
  nonSupplyCoerced: boolean;
  /**
   * The line settles a control account, so the claim was dropped (K-017).
   * A THIRD outcome rather than a reuse of the two above: neither statute
   * fired, and a caller counting denials must not count these among them.
   */
  settlementDropped: boolean;
}

export async function resolveRuleVatCode(input: RuleVatInput): Promise<RuleVatDecision> {
  const {
    allocType, companyId, requestedVatCode, glAccountId,
    ruleGlAccountVatDenied, ruleGlAccountName, denialContext, guardContext,
  } = input;

  // K-017: a rule with a supplier or customer on it settles a document that
  // already accounted for the VAT, so the code is dropped rather than passed
  // through — `isControlAccountSettlement` carries the reasoning, and
  // `allocateTransaction` applies the same predicate on the attended path.
  // Neither guard below applies: there is no contra account to judge.
  if (isControlAccountSettlement(allocType)) {
    // Reported, not silent. The two statutory guards each log and each raise a
    // counter; a third way for a requested code to vanish on an UNATTENDED path
    // has to say so too, or the only evidence a rule is misconfigured is a
    // journal nobody reads.
    if (requestedVatCode !== 'none') {
      log.info(
        'VAT code dropped: allocation settles a control account, not a supply',
        { companyId, allocType, requestedVatCode, ...guardContext },
        'accounting',
      );
    }
    return { vatCode: 'none', denied: false, nonSupplyCoerced: false, settlementDropped: true };
  }

  if (allocType !== 'account') {
    return { vatCode: requestedVatCode, denied: false, nonSupplyCoerced: false, settlementDropped: false };
  }

  const canBatch = ruleGlAccountVatDenied !== undefined && ruleGlAccountName !== undefined;

  if (canBatch) {
    const denial = applyVatDenial(ruleGlAccountVatDenied, requestedVatCode, denialContext);
    if (denial.denied) {
      return { vatCode: denial.vatCode, denied: true, nonSupplyCoerced: false, settlementDropped: false };
    }
    const guard = applyNonSupplyGuard(ruleGlAccountName ?? null, requestedVatCode, {
      companyId, ...guardContext,
    });
    return { vatCode: guard.vatCode, denied: false, nonSupplyCoerced: guard.coerced, settlementDropped: false };
  }

  const denial = await resolveVatCodeForAccount(
    companyId, glAccountId, requestedVatCode, denialContext,
  );
  if (denial.denied) {
    return { vatCode: denial.vatCode, denied: true, nonSupplyCoerced: false, settlementDropped: false };
  }
  const guard = await resolveNonSupplyForAccount(
    companyId, glAccountId, requestedVatCode, guardContext,
  );
  return { vatCode: guard.vatCode, denied: false, nonSupplyCoerced: guard.coerced, settlementDropped: false };
}
