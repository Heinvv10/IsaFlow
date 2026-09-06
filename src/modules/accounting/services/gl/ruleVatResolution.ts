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

import { applyVatDenial, resolveVatCodeForAccount } from './inputVatDenial';
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
}

export async function resolveRuleVatCode(input: RuleVatInput): Promise<RuleVatDecision> {
  const {
    allocType, companyId, requestedVatCode, glAccountId,
    ruleGlAccountVatDenied, ruleGlAccountName, denialContext, guardContext,
  } = input;

  if (allocType !== 'account') {
    return { vatCode: requestedVatCode, denied: false, nonSupplyCoerced: false };
  }

  const canBatch = ruleGlAccountVatDenied !== undefined && ruleGlAccountName !== undefined;

  if (canBatch) {
    const denial = applyVatDenial(ruleGlAccountVatDenied, requestedVatCode, denialContext);
    if (denial.denied) {
      return { vatCode: denial.vatCode, denied: true, nonSupplyCoerced: false };
    }
    const guard = applyNonSupplyGuard(ruleGlAccountName ?? null, requestedVatCode, {
      companyId, ...guardContext,
    });
    return { vatCode: guard.vatCode, denied: false, nonSupplyCoerced: guard.coerced };
  }

  const denial = await resolveVatCodeForAccount(
    companyId, glAccountId, requestedVatCode, denialContext,
  );
  if (denial.denied) {
    return { vatCode: denial.vatCode, denied: true, nonSupplyCoerced: false };
  }
  const guard = await resolveNonSupplyForAccount(
    companyId, glAccountId, requestedVatCode, guardContext,
  );
  return { vatCode: guard.vatCode, denied: false, nonSupplyCoerced: guard.coerced };
}
