/**
 * The supplier DOCUMENT an unattended rule sweep owes the cash it posts.
 *
 * Split out of `bankRuleAutoPostLine` when the refund arm took that file past
 * the 300-line cap. The seam is altitude, not size: everything here answers
 * "what subledger document does this posted journal need?", and nothing here
 * decides whether to post, what the lines are, or what VAT they carry.
 *
 * ── WHY THE SWEEP NEEDS ITS OWN CALL AT ALL ─────────────────────────────────
 *
 * `autoPostRuleLine` posts its OWN journal rather than calling
 * `allocateTransaction`, so the payment document that path creates was never
 * created here: a rule sweep debited Accounts Payable hundreds of times and
 * left no supplier payment behind any of it. Every one of those lines is cash
 * on the control account that no document — and therefore no report and no
 * apply tool — can reach.
 *
 * ── THE TWO DIRECTIONS ──────────────────────────────────────────────────────
 *
 * Money OUT is a PAYMENT and may be applied, on the rule's own `auto_apply`
 * instruction (migration 676). Unattended there is no caller to ask, and an
 * unreadable value is the DEFAULT rather than `'none'`: a rule row written
 * before the column existed reads as NULL, and treating that as "apply nothing"
 * would reproduce the very state this exists to end.
 *
 * Money IN is a REFUND and is NEVER applied, at any `auto_apply` the rule
 * carries — a negative remainder applied to a bill un-pays it. That is why
 * `recordSupplierRefund` takes no mode: there is none.
 *
 * ── FAILURE IS NOT CAUGHT ───────────────────────────────────────────────────
 *
 * Both calls write, and a caught write is a partial commit reported as a
 * success — see `ap/supplierAutoAllocate`. A refund breaching the supplier's
 * on-account-credit ceiling throws; unattended, the sweep's own savepoint
 * unwinds THAT LINE and the rest of the batch stands, which is the right
 * outcome. A refund larger than the credit is a line a person has to look at.
 */

import { recordSupplierBankPayment } from '../ap/supplierAutoAllocate';
import { recordSupplierRefund } from '../ap/supplierRefundDocument';
import { DEFAULT_AUTO_APPLY, parseAutoApplyMode } from '../shared/autoAllocateStrategy';

export interface RuleSupplierDocumentArgs {
  companyId: string;
  supplierId: string;
  /** The rule's `auto_apply` column, unparsed. Ignored on a refund. */
  ruleAutoApply: unknown;
  bankTxId: string;
  bankAccountId: string;
  journalEntryId: string;
  /** The absolute value of the bank line. */
  amount: number;
  paymentDate: string;
  description: string;
  userId: string;
  /** Money IN. Decided from the line's sign by the caller, never re-derived. */
  isDeposit: boolean;
}

/**
 * Create the payment or refund document for a journal the sweep has just
 * posted. Call it INSIDE the block that wrote the bank journal line: without
 * `matched_journal_line_id` the transaction stays `imported`, and a `processed`
 * document against a line still open for allocation is the one double-document
 * path left — re-allocating it posts a second journal and a second document for
 * the same cash.
 */
export async function recordRuleSupplierDocument(
  args: RuleSupplierDocumentArgs,
): Promise<void> {
  const {
    companyId, supplierId, bankTxId, bankAccountId, journalEntryId,
    amount, paymentDate, description, userId, isDeposit,
  } = args;
  const common = {
    companyId, supplierId, bankTxId, bankAccountId, journalEntryId,
    amount, paymentDate, description, userId,
  };

  if (isDeposit) {
    await recordSupplierRefund(common);
    return;
  }
  await recordSupplierBankPayment({
    ...common,
    autoApply: parseAutoApplyMode(args.ruleAutoApply) ?? DEFAULT_AUTO_APPLY,
  });
}
