/**
 * The customer-invoice arm of a confirmed bank match (`bank-match-confirm`).
 *
 * The MIRROR of `confirmSupplierMatch.ts`, and it exists for the same reason.
 * The branch this replaces called `allocateTransaction(… 'customer', …,
 * { autoApply: false })` and then wrote `customer_invoices.amount_paid`
 * ABSOLUTELY, with no `customer_payment_allocations` row behind it. Two
 * consequences, both silent:
 *
 *   · IRREVERSIBLE. `bankAllocationUnwind#unwindOnePayment` reverses
 *     `amount_paid` from `customer_payment_allocations`; with zero rows it
 *     reports `invoicesReopened: 0`, so a reversal returns the credit to the AR
 *     control account and leaves the invoice reading as paid. The gap between
 *     control and subledger widens by the reversed amount behind an
 *     ordinary-looking contra.
 *   · LOST UPDATE. `newPaid` was computed in JS from a balance read before the
 *     journal posted, so a concurrent settlement was overwritten rather than
 *     added to. `applyLineToInvoice` moves the column by `+ x` in SQL.
 *
 * `confirmReceiptMatch` already does all of this correctly for the receipt-match
 * screen and for MCP: one journal for the whole line, a `customer_payments`
 * document carrying it, applied through `customer_payment_allocations`. This
 * arm now routes there, so there is ONE implementation of "may this receipt
 * settle this invoice" rather than two that disagree.
 *
 * THE ORDER IS THE WHOLE POINT, as on the supplier arm. `withAuth` decides
 * COMMIT vs ROLLBACK on `res.statusCode >= 500`, so a 4xx raised after a write
 * COMMITS it. Everything refusable is refused from READS
 * (`validateBankReceiptApplication`), before `confirmReceiptMatch` writes
 * anything; after that the caller must answer 500 and let the request roll back.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  confirmReceiptMatch,
  validateBankReceiptApplication,
} from '../ar/receiptMatchConfirmService';
import { EPS, round2 } from '../ar/receiptAllocationLines';
import { isReceiptRefusal, isRetryableReceiptRefusal } from '../ar/receiptRefusal';
import { lockBankTransactionForUpdate } from './bankTxLock';

export type ConfirmCustomerMatchOutcome =
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'refused'; message: string }
  | { ok: false; kind: 'contended'; message: string }
  | { ok: true; customerPaymentId: string; allocated: number };

/**
 * @param paymentAmount The ABSOLUTE value of the bank line. The caller has
 *   already refused a line pointing the wrong way, which is why the sign is
 *   gone by the time it arrives here.
 */
export async function confirmCustomerInvoiceMatch(
  companyId: string,
  bankTransactionId: string,
  invoiceId: string,
  userId: string,
  paymentAmount: number,
): Promise<ConfirmCustomerMatchOutcome> {
  // BANK LINE FIRST — THE CANONICAL LOCK ORDER (`bank/.claude.md`).
  //
  // Every other write path takes `bank_transactions` before the document it
  // settles: `allocateTransaction`, `splitAllocateTransaction` and
  // `reverseReconciledTransaction` all lock the line and only then move
  // `customer_invoices`. This arm reads the invoice below and locks it
  // inside `fetchInvoiceCandidates` — so without this call the order
  // here is document → bank line, the exact inverse. Request A confirming
  // (L, I) would hold I and want L while request B allocating L auto-resolved
  // to I holds L and wants I: Postgres breaks the cycle with 40P01, which
  // `withAuth` answers as a 500 over a money path where the honest answer is
  // "retry". `isLockContention` now maps that to a retryable refusal, but the
  // order is what stops it arising.
  //
  // The row is deliberately discarded. The lock is taken for its ORDER and for
  // the bonus that it makes the `status = 'imported'` read in
  // `validateBankReceiptApplication` race-free; a line that has vanished (or
  // belongs to another tenant) is still refused by that validator's own
  // not-found wording, which callers already depend on. Contention here throws
  // `BankTransactionLockTimeoutError`, which the route answers 409, pre-write.
  await lockBankTransactionForUpdate(companyId, bankTransactionId);

  const invRows = (await sql`
    SELECT id, total_amount, amount_paid
    FROM customer_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as Record<string, unknown>[];
  if (invRows.length === 0) return { ok: false, kind: 'not_found' };

  const inv = invRows[0]!;
  const outstanding = round2(Number(inv.total_amount) - Number(inv.amount_paid || 0));
  if (outstanding <= EPS) {
    return { ok: false, kind: 'refused', message: 'This customer invoice is already fully paid.' };
  }

  // REFUSED, not capped — the same rule as the supplier arm, on the same
  // evidence. The branch this replaces capped at `min(line, outstanding)` and
  // left the excess sitting on the AR control account, and `debtorsManager`
  // builds the aging from `customer_invoices` alone (there is no unapplied-cash
  // credit anywhere in it), so control and aging would part by the excess with
  // nothing on any AR report to say why. The receipt document would hold the
  // remainder and `list_unapplied_receipts` would report it — which is a real
  // improvement on today, but it is not a report a debtors clerk reads.
  //
  // A caller that HANDS IN its allocations may leave a remainder; this screen
  // derives them from the single invoice the user picked, so a remainder here
  // is a mis-match rather than an instruction.
  if (paymentAmount > outstanding + EPS) {
    return {
      ok: false,
      kind: 'refused',
      message: `This line is R${paymentAmount.toFixed(2)} but only R${outstanding.toFixed(2)} is `
        + `outstanding on the invoice. The R${round2(paymentAmount - outstanding).toFixed(2)} excess `
        + 'would sit unapplied where the debtors aging cannot see it. Split the line, or capture the '
        + 'receipt against every invoice it settles.',
    };
  }

  const allocations = [{ invoiceId, amount: round2(paymentAmount) }];

  // Reads only: line already allocated, closed or missing fiscal period,
  // cancelled invoice, money the wrong way, a foreign-tenant invoice. Each
  // refusal carries its own remedy and none of them has written anything.
  try {
    await validateBankReceiptApplication(companyId, bankTransactionId, allocations);
  } catch (refusal) {
    // Typed, not "carries no SQLSTATE code": that older test was equally true of
    // a TypeError raised on the same call, which would then be handed to the
    // user verbatim as a 400 — a status `withAuth` COMMITs, monitored as their
    // mistake rather than as the fault it is.
    if (!isReceiptRefusal(refusal)) throw refusal;
    // Contention is not a mis-match — the AP arm's comment applies verbatim.
    if (isRetryableReceiptRefusal(refusal)) {
      return { ok: false, kind: 'contended', message: refusal.message };
    }
    return { ok: false, kind: 'refused', message: refusal.message };
  }

  // POST-WRITE FROM HERE. `confirmReceiptMatch` re-runs the same validation as
  // its own race guard and then posts; nothing below may be caught, or a race
  // answers 4xx over a committed journal.
  const applied = await confirmReceiptMatch(companyId, {
    bankTxId: bankTransactionId, userId, allocations,
  });

  log.info('Confirmed match: customer invoice', {
    bankTransactionId, invoiceId, paymentAmount, outstanding,
    customerPaymentId: applied.customerPaymentId, allocated: applied.allocatedTotal,
  }, 'accounting-api');

  return {
    ok: true,
    customerPaymentId: applied.customerPaymentId,
    allocated: applied.allocatedTotal,
  };
}
