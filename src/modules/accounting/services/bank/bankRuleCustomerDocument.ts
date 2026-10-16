/**
 * The customer DOCUMENT an unattended rule sweep owes the cash it posts — the
 * AR twin of `bankRuleSupplierDocument`, and for the same reason.
 *
 * `autoPostRuleLine` posts its OWN journal rather than calling
 * `allocateTransaction`, so a customer rule credited (or debited) Accounts
 * Receivable with no `customer_payments` row behind it: cash on the control
 * account that no statement, aging, reconciler or apply tool can reach, and the
 * AR subledger drifts from the control by the amount.
 *
 * ── THE TWO DIRECTIONS ──────────────────────────────────────────────────────
 *
 * Money IN is a RECEIPT: the row `allocateTransaction` inserts for a whole
 * customer line (ar/customerBankReceipt), applied on the rule's own
 * `auto_apply` instruction. Unattended there is no caller to ask, so an
 * unreadable value is the DEFAULT rather than `'none'`, as on the supplier side.
 *
 * Money OUT is a REFUND (ar/customerRefundDocument) and is never applied. A
 * refund larger than the credit the customer holds is refused there.
 *
 * ── FAILURE IS NOT CAUGHT ───────────────────────────────────────────────────
 *
 * Both write; a caught write is a partial commit reported as a success. The
 * sweep runs each line in its own savepoint: a refund refusal unwinds THAT line
 * and is counted as a skip (`autoPostSkippedRefundCeiling`), the rest stands.
 */
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { insertCustomerBankReceipt } from '../ar/customerBankReceipt';
import { autoApplyCustomerReceipt } from '../ar/customerAutoAllocate';
import { recordCustomerRefund } from '../ar/customerRefundDocument';
import { DEFAULT_AUTO_APPLY, parseAutoApplyMode } from '../shared/autoAllocateStrategy';
import { sql } from '@/lib/neon';

export interface RuleCustomerDocumentArgs {
  companyId: string;
  customerId: string;
  /** The rule's `auto_apply` column, unparsed. Ignored on a refund. */
  ruleAutoApply: unknown;
  bankTxId: string;
  bankAccountId: string;
  /** The bank line's reference, carried onto the receipt as the screen's allocation does. */
  bankReference: string | null;
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
 * Create the receipt or refund document for a journal the sweep has just
 * posted. Called INSIDE the block that wrote the bank journal line, for the
 * reason `recordRuleSupplierDocument` gives.
 */
export async function recordRuleCustomerDocument(args: RuleCustomerDocumentArgs): Promise<void> {
  const { companyId, customerId, bankTxId, bankAccountId, journalEntryId, amount, paymentDate, description, userId } = args;
  if (!args.isDeposit) {
    await recordCustomerRefund({ companyId, customerId, bankTxId, bankAccountId, journalEntryId, amount, paymentDate, description, userId });
    return;
  }
  const paymentId = await insertCustomerBankReceipt(sql, {
    companyId, customerId, paymentDate, amount, bankReference: args.bankReference, bankAccountId, description,
    journalEntryId, createdBy: await resolveUserUuid(userId),
  });
  if (!paymentId) throw new Error(`Rule receipt for bank line ${bankTxId} was not recorded`);
  await autoApplyCustomerReceipt({
    companyId, customerId, paymentId, journalEntryId, amount, userId,
    autoApply: parseAutoApplyMode(args.ruleAutoApply) ?? DEFAULT_AUTO_APPLY,
  });
}
