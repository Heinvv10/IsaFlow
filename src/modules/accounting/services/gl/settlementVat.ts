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
 *
 * THE ONE CONDITION THEY DO NOT SHARE, and why it is not drift.
 * `allocateTransaction` ANDs this with `Boolean(entityId)`, because a supplier
 * or customer call WITHOUT an entity falls THROUGH to its `account` arm and is
 * a plain GL allocation that must still split. The rule sweep has no such
 * fall-through: `buildAutoCreateLines` picks its arm on `allocType` alone and
 * dereferences `apAccountId!` / `arAccountId!`, so an entity test there would
 * only make the two disagree. Unreachable in production on the attended side
 * either way — `pages/api/accounting/bank-transactions-action.ts` returns 400
 * and the MCP tool returns ENTITY_REQUIRED for a settlement with no entity.
 *
 * KNOWN LIMIT — a prepayment. This is applied to every supplier/customer
 * allocation, not only to those that settle an existing document. Cash received
 * from a customer with no open invoice is an advance, and under VAT Act s9(1)
 * the time of supply is the earlier of invoice or payment, so output tax IS due
 * on it. After this change such a receipt cannot carry output tax on any path.
 * Accepted, not overlooked: the allocation screen never offered the choice
 * (`BankTxTable` renders N/A for these types), leaving only the rule sweep and
 * the MCP tools able to express it, and posting a deposit correctly needs an
 * advance-payments liability account this module does not model yet. Raise the
 * output tax on the invoice when it is issued.
 */
export function isControlAccountSettlement(allocType: string): boolean {
  return allocType === 'supplier' || allocType === 'customer';
}
