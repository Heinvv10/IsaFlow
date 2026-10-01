/**
 * Whether a bank line's SIGN agrees with the subledger document it is being
 * settled against.
 *
 * ── WHY THIS IS A RULE AND NOT A BRANCH ─────────────────────────────────────
 *
 * Settling a bill is money going OUT; settling a customer invoice is money
 * coming IN. Every path that settles a document derives the amount it applies
 * with `Math.abs(...)` — `applyBankLineToSupplierInvoices`, `confirmReceiptMatch`
 * and the `bank-match-confirm` route each do it independently — so by the time
 * the settlement is computed the direction is gone, and a REFUND applied to an
 * invoice looks exactly like a payment of it.
 *
 * That was survivable only by accident. While `allocateTransaction` posted the
 * payment direction unconditionally, a money-in line against a bill posted
 * DR AP / CR Bank AND reduced `amount_paid`: both wrong about the bank, both
 * wrong the same way, so the control account and the subledger stayed equal.
 * Making the journal follow the sign broke that symmetry — the journal now
 * raises the liability while an unguarded settler still reduces it, and AP
 * control and AP subledger differ by TWICE the line.
 *
 * So the rule lives here, in the module that owns bank lines, and every settler
 * asks it the same question. It is deliberately NOT in the MCP tool layer: the
 * REST route reaches it too, and a rule with two copies is a rule with two
 * answers the first time one of them is edited.
 *
 * ── REFUSE, RATHER THAN REINTERPRET ─────────────────────────────────────────
 *
 * There is no refund-APPLICATION concept for either side — no "negative
 * allocation" against an invoice — and inventing one silently is the same class
 * of guess that put R261,651.64 on the wrong side of Velocity Fibre's ledger.
 * A refund posts as a refund JOURNAL (`allocateTransaction` with no invoice),
 * which is what every refusal below points the caller at.
 */

/** The two document kinds a bank line can be settled against. */
export type SettlementKind = 'customer' | 'supplier';

/**
 * A reason this line's sign contradicts the document it names, or null when the
 * direction is consistent.
 *
 * Pure, so no two callers can drift on the wording, and so a `dry_run` reports
 * exactly what the live call will do.
 *
 * The thresholds are `>= 0` and `<= 0`, NOT `> 0` and `< 0`, and the zero case
 * is the reason. An earlier version passed zero through on the reasoning that
 * the caller's balance check would refuse it — it does not:
 * `skipReasonForInvoice(state, id, 0)` against R500 outstanding runs
 * `0 > 500.01`, which is false, and calls the line postable. It then reaches
 * `validateBankSupplierPayment` (`tx.amount >= 0`) or
 * `validateBankReceiptApplication` (`tx.amount <= 0`), both of which THROW —
 * mid-write, past the point `bulkAllocationSkip` can skip around it, so the
 * registry savepoint unwinds every other line in the batch. One R0.00
 * statement line would destroy a 500-line batch, which is the single outcome
 * that file exists to prevent. A pre-write guard that fronts a mid-write throw
 * has to use the throw's own thresholds or it is not a guard.
 */
export function signMismatchReason(kind: SettlementKind, signedAmount: number): string | null {
  if (signedAmount === 0) {
    return 'R0.00 settles nothing — a document is settled by money moving';
  }
  if (kind === 'supplier' && signedAmount > 0) {
    return `R${signedAmount.toFixed(2)} is money IN and cannot settle a bill — `
      + 'drop invoice_id to book it as a supplier refund, or name a money-out line';
  }
  if (kind === 'customer' && signedAmount < 0) {
    return `R${Math.abs(signedAmount).toFixed(2)} is money OUT and cannot settle a customer `
      + 'invoice — drop invoice_id to book it as a customer refund, or name a money-in line';
  }
  return null;
}
