/**
 * A supplier or customer bank allocation SETTLES a document; it is not a supply.
 *
 * The bill credited AP with the gross and claimed the input tax when it was
 * posted; the invoice debited AR with the gross and raised the output tax then.
 * Cash arriving later moves the control account and the bank, and nothing else.
 * Splitting that cash 15% exclusive relieves the control account by the NET
 * while the bank leg and the payment document both carry the GROSS — the VAT
 * portion strands on AP/AR permanently and the input tax is claimed twice.
 *
 * The `account` arm is the case the split is legitimately for: an expense with
 * no document behind it, where the VAT has not been accounted for yet.
 *
 * ONE PREDICATE, BOTH POSTERS. `allocateTransaction` (attended) and
 * `resolveRuleVatCode` (the unattended rule sweep) each carried this defect
 * independently — K-016 and K-017. They call this so they cannot diverge again.
 */
export function isControlAccountSettlement(allocType: string): boolean {
  return allocType === 'supplier' || allocType === 'customer';
}
