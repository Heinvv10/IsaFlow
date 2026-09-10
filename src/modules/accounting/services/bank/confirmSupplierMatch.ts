/**
 * The supplier-invoice arm of a confirmed bank match (`bank-match-confirm`).
 *
 * Its own module because the route is at the file-size ceiling and because the
 * reasoning here is accounting, not HTTP: what a match may settle, what it must
 * refuse, and which of those refusals may still be answered with a 4xx.
 *
 * THE ORDER IS THE WHOLE POINT. `withAuth` decides COMMIT vs ROLLBACK on
 * `res.statusCode >= 500`, so a 4xx raised after a write COMMITS it. Everything
 * that can be refused is therefore refused from READS, before the first write;
 * after that the caller must answer 500 and let the request roll back.
 *
 * This does NOT settle the bill itself. `applyBankLineToSupplierInvoices` owns
 * that — one journal, one `supplier_payments` document carrying it, applied
 * through `payment_allocations`. Those are the two tables
 * `bankAllocationUnwind` reads, and a settlement written any other way cannot
 * be reversed.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  applyBankLineToSupplierInvoices,
  validateBankSupplierPayment,
} from '../ap/supplierBankPaymentService';
import { EPS, round2 } from '../ap/supplierAllocationLines';
import {
  isRetryableSupplierPaymentRefusal,
  isSupplierPaymentRefusal,
} from '../ap/supplierPaymentRefusal';
import { lockBankTransactionForUpdate } from './bankTxLock';

export type ConfirmSupplierMatchOutcome =
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'refused'; message: string }
  | { ok: false; kind: 'contended'; message: string }
  | { ok: true; supplierPaymentId: string; paymentNumber: string; allocated: number };

/**
 * @param paymentAmount The ABSOLUTE value of the bank line. The caller has
 *   already refused a line pointing the wrong way, which is why the sign is
 *   gone by the time it arrives here.
 */
export async function confirmSupplierInvoiceMatch(
  companyId: string,
  bankTransactionId: string,
  invoiceId: string,
  userId: string,
  paymentAmount: number,
): Promise<ConfirmSupplierMatchOutcome> {
  // BANK LINE FIRST — THE CANONICAL LOCK ORDER (`bank/.claude.md`).
  //
  // Every other write path takes `bank_transactions` before the document it
  // settles: `allocateTransaction`, `splitAllocateTransaction` and
  // `reverseReconciledTransaction` all lock the line and only then move
  // `supplier_invoices`. This arm reads the bill below and locks it
  // inside `fetchBillCandidates` — so without this call the order
  // here is document → bank line, the exact inverse. Request A confirming
  // (L, I) would hold I and want L while request B allocating L auto-resolved
  // to I holds L and wants I: Postgres breaks the cycle with 40P01, which
  // `withAuth` answers as a 500 over a money path where the honest answer is
  // "retry". `isLockContention` now maps that to a retryable refusal, but the
  // order is what stops it arising.
  //
  // The row is deliberately discarded. The lock is taken for its ORDER and for
  // the bonus that it makes the `status = 'imported'` read in
  // `validateBankSupplierPayment` race-free; a line that has vanished (or
  // belongs to another tenant) is still refused by that validator's own
  // not-found wording, which callers already depend on. Contention here throws
  // `BankTransactionLockTimeoutError`, which the route answers 409, pre-write.
  await lockBankTransactionForUpdate(companyId, bankTransactionId);

  const invRows = (await sql`
    SELECT id, total_amount, amount_paid
    FROM supplier_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as Record<string, unknown>[];
  if (invRows.length === 0) return { ok: false, kind: 'not_found' };

  const inv = invRows[0]!;
  const outstanding = round2(Number(inv.total_amount) - Number(inv.amount_paid || 0));
  if (outstanding <= EPS) {
    return { ok: false, kind: 'refused', message: 'This supplier invoice is already fully paid.' };
  }

  // REFUSED, not capped. `allocateTransaction` relieves AP control by the WHOLE
  // line while the bill can only take its outstanding balance, and
  // `apAgingService` builds the aging from `supplier_invoices` alone — there is
  // no unapplied-payment credit anywhere in it. So an over-payment would leave
  // the control account and the aging permanently apart by the excess, with
  // nothing on any AP report to say why.
  //
  // A caller that HANDS IN its allocations may leave a remainder — the MCP
  // apply tool does, and the payment document holds it. This screen is not that
  // caller: it derives the allocation itself from the single bill the user
  // picked, so a remainder here is a mis-match rather than an instruction, and
  // the honest answer is to name the excess and let the user split the line.
  if (paymentAmount > outstanding + EPS) {
    return {
      ok: false,
      kind: 'refused',
      message: `This line is R${paymentAmount.toFixed(2)} but only R${outstanding.toFixed(2)} is `
        + `outstanding on the invoice. The R${round2(paymentAmount - outstanding).toFixed(2)} excess `
        + 'would sit unapplied where the AP aging cannot see it. Split the line, or capture the '
        + 'payment against every bill it settles.',
    };
  }

  const allocations = [{ invoiceId, amount: round2(paymentAmount) }];

  // Reads only: line already allocated, closed or missing fiscal period,
  // cancelled bill, money the wrong way. Each refusal carries its own remedy,
  // and none of them has written anything yet.
  //
  // ONLY a `SupplierPaymentRefusal` is one of those. Catching every throw here
  // classified a dropped connection or a `25P02` as the user's fault: the route
  // answers a refusal with `apiResponse.badRequest`, which passes the message
  // straight through, so raw Postgres text reached the browser as a 400 and a
  // real server fault was monitored as a client error — on a status `withAuth`
  // COMMITs. Anything else is re-thrown for the route's 500 branch.
  let validation;
  try {
    validation = await validateBankSupplierPayment(companyId, bankTransactionId, allocations);
  } catch (refusal) {
    if (!isSupplierPaymentRefusal(refusal)) throw refusal;
    // Contention is not a mis-match. `fetchBillCandidates` raises its
    // lock-timeout as a refusal too, and answering that 400 tells the user they
    // did something wrong when the truth is "try again" — while the same
    // instant of contention on the bank LINE already answers 409. Separated
    // here so the route can answer both the same way.
    if (isRetryableSupplierPaymentRefusal(refusal)) {
      return { ok: false, kind: 'contended', message: refusal.message };
    }
    return { ok: false, kind: 'refused', message: refusal.message };
  }

  // Handed the validation it just made rather than letting the service repeat
  // it: one decision, taken once, with no second window for it to change in.
  const applied = await applyBankLineToSupplierInvoices(companyId, {
    bankTxId: bankTransactionId, userId, allocations, validation,
  });

  log.info('Confirmed match: supplier invoice', {
    bankTransactionId, invoiceId, paymentAmount, outstanding,
    supplierPaymentId: applied.supplierPaymentId, allocated: applied.allocatedTotal,
  }, 'accounting-api');

  return {
    ok: true,
    supplierPaymentId: applied.supplierPaymentId,
    paymentNumber: applied.paymentNumber,
    allocated: applied.allocatedTotal,
  };
}
