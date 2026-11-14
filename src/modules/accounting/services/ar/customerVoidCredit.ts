/**
 * The refusal every write that REMOVES unapplied receipt cash makes before its first write (Hein, 2026-11-14): a
 * cancellation of a customer receipt and an application of an existing receipt's remainder. Either would be refused
 * when it leaves the customer's running on-account credit below zero on a date it lowers (`ar/customerRunningCredit`:
 * the rule, by date) — a refund already returned that cash. The AR twin of `ap/supplierVoidCredit`. A refund is judged
 * by the very same rule (`ar/customerRefundDocument.planCustomerRefund`: it takes its amount off from its own date on),
 * so the three writes that lower the credit agree; the all-dates figure let a receipt dated after the refund hide it
 * (breaker R2-2).
 *
 * WHAT LOWERS NOTHING is never refused: a fully applied receipt, a refund, a receipt and its own refund together. A
 * customer already below zero on some date is refused only writes that lower that date.
 *
 * LOCK: the customer row, TRIED (`ar/customerCreditLock`), taken AFTER the receipt row and the invoices the write
 * touches and before any write — the canonical payments → invoices → customers. Tried, so this path never waits on it.
 *
 * BULK (`judgeReceiptCancellations` / `withReceiptCancellationsJudged`): a call that cancels several receipts at once
 * judges the whole set ONCE, by the same function its dry run uses, so the two agree by construction. The per-receipt
 * check inside it then only VERIFIES, under that receipt's locks and the customer's, that nothing the judgment read
 * has moved since (the receipt still the judged customer's, with its judged remainder; once per customer, the other
 * rows' figures not fallen on any date and no judged row moved) — a refusal there is retryable, never a second
 * opinion on the books. A reallocation to the SAME customer judges with the new receipt's floor netted in (`reAdd`).
 *
 * Residual: an UNAPPLY (raises credit) takes no customer lock; harmless, it only makes a read conservative.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { tryLockCustomerCredit } from './customerCreditLock';
import {
  cents, customerCreditDays, judgeCreditDays, lowersBelowZero, withDatedRemovals, type CreditDay, type CreditRemoval,
} from './customerRunningCredit';
import { ReceiptRefusal, isReceiptRefusal } from './receiptRefusal';

export interface CustomerVoidCreditShortfall {
  customerId: string;
  customerName: string;
  /** The unapplied cash the write takes off the customer's account. */
  lowers: number;
  /** The lowest running credit from `fromDate` onward, before the write. */
  credit: number;
  /** The earliest date the write lowers: the credit is judged from here on. */
  fromDate: string;
}

/** The credit refusal, told apart from the other receipt refusals (a run undo retries it after its other rows). */
export class CustomerVoidCreditRefusal extends ReceiptRefusal {
  readonly reason = 'credit_ceiling' as const;
}

/** Structural, as `isReceiptRefusal` is. */
export function isCustomerVoidCreditRefusal(err: unknown): err is CustomerVoidCreditRefusal {
  return isReceiptRefusal(err) && (err as { reason?: unknown }).reason === 'credit_ceiling';
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface RemovedRow { paymentId: string; customerId: string; remainder: number; removes: number }

/** The live rows `removals` names, with their customer and remainder (company-scoped). */
async function removedRows(companyId: string, removals: readonly CreditRemoval[]): Promise<RemovedRow[]> {
  if (removals.length === 0) return [];
  const rows = (await sql`
    SELECT cp.id::TEXT AS id, cp.client_id::TEXT AS customer_id,
           cp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)) AS remainder
    FROM customer_payments cp
    LEFT JOIN LATERAL (
      SELECT SUM(cpa.amount_allocated) AS allocated FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id
    ) alloc ON TRUE
    WHERE cp.company_id = ${companyId}::UUID AND cp.id = ANY(${removals.map((r) => r.paymentId)}::UUID[])
      AND cp.status <> 'cancelled' AND cp.client_id IS NOT NULL
    ORDER BY cp.client_id, cp.id`) as DbRow[];
  const amountOf = new Map(removals.map((r) => [r.paymentId.toLowerCase(), r.amount]));
  return rows.map((r) => {
    const remainder = Number(r.remainder ?? 0);
    return { paymentId: String(r.id), customerId: String(r.customer_id), remainder,
      removes: amountOf.get(String(r.id).toLowerCase()) ?? remainder };
  });
}

const byCustomer = (rows: readonly RemovedRow[]) => {
  const out = new Map<string, RemovedRow[]>();
  for (const r of rows) out.set(r.customerId, [...(out.get(r.customerId) ?? []), r]);
  return out;
};

interface CustomerSnapshot { customerId: string; days: CreditDay[]; rows: RemovedRow[] }

/** Cash the same write puts back on one customer on one date (a reallocation's new receipt). */
export interface CreditReAdd { customerId: string; date: string; amount: number }

/** Judge `removals` per customer; the first shortfall, and what each customer's judgment read. */
async function judge(companyId: string, removals: readonly CreditRemoval[], lock: boolean, reAdd?: CreditReAdd) {
  const snapshots: CustomerSnapshot[] = [];
  for (const [customerId, rows] of byCustomer(await removedRows(companyId, removals))) {
    if (rows.every((r) => cents(r.removes) <= 0)) continue; // lowers nothing: no lock, never refused
    if (lock) await tryLockCustomerCredit(companyId, customerId);
    const { customerName, days } = await customerCreditDays(companyId, customerId,
      rows.map((r) => ({ paymentId: r.paymentId, amount: r.removes })));
    snapshots.push({ customerId, days, rows });
    const back = reAdd && sameId(reAdd.customerId, customerId) && reAdd.amount > 0
      ? [{ date: reAdd.date, amount: -reAdd.amount }] : [];
    const j = judgeCreditDays(withDatedRemovals(days, back));
    if (lowersBelowZero(j) && j.fromDate) {
      const shortfall: CustomerVoidCreditShortfall = { customerId, customerName, lowers: j.lowers, credit: j.lowest, fromDate: j.fromDate };
      return { shortfall, snapshots };
    }
  }
  return { shortfall: null, snapshots };
}

/**
 * The first customer whose credit cancelling `paymentIds` would take below zero on a date it lowers, or null.
 * `reAdd`: cash the same write records again for one customer on one date (a reallocation to the same customer), which
 * nets against what the cancellation removes.
 */
export async function customerVoidCreditShortfall(
  companyId: string, paymentIds: readonly string[], reAdd?: CreditReAdd,
): Promise<CustomerVoidCreditShortfall | null> {
  return (await judge(companyId, paymentIds.map((paymentId) => ({ paymentId })), true, reAdd)).shortfall;
}

function refusal(s: CustomerVoidCreditShortfall, what: string, remedy: string): CustomerVoidCreditRefusal {
  return new CustomerVoidCreditRefusal(
    `${what} would leave ${s.customerName} owing the company: it takes ${formatMoney(s.lowers)} of `
    + `unapplied cash off the customer's account from ${s.fromDate}, and on some date since then only `
    + `${formatMoney(Math.max(s.credit, 0))} is on account — a refund has already returned the rest. ${remedy}`,
  );
}
const cancelling = (n: number) => (n > 1 ? 'Cancelling these receipts' : 'Cancelling this receipt');
const CANCEL_REMEDY = 'Reverse the refund first, then cancel the receipt.';

/** A judged set: what each customer's judgment read, and the customers verified (and locked) since. */
const judged = new AsyncLocalStorage<{ companyId: string; snapshots: Map<string, CustomerSnapshot>; verified: Set<string> }>();

/**
 * Re-checks, under this receipt's locks and its customer's, that a set judged up front still stands: the receipt is
 * still the judged customer's with the judged remainder, and — once per customer, at its first receipt — no other row
 * of that customer has fallen on any date and no judged row has moved. After that first verification the customer row
 * is held by this request, and every writer that can LOWER its other rows waits for it or is refused (a refund's
 * `FOR UPDATE`, an application's or a cancel's tried lock, a merge's `FOR UPDATE`); an unapply only raises. Null when
 * `paymentIds` are not all in a judged set (the caller then judges them itself).
 */
async function verifyJudged(companyId: string, paymentIds: readonly string[]): Promise<boolean | null> {
  const ctx = judged.getStore();
  if (!ctx || ctx.companyId !== companyId) return null;
  const all = [...ctx.snapshots.values()];
  const snapOf = (id: string) => all.find((s) => s.rows.some((r) => sameId(r.paymentId, id)));
  const live = await removedRows(companyId, paymentIds.map((paymentId) => ({ paymentId })));
  for (const row of live) {
    const snap = snapOf(row.paymentId);
    if (!snap) {
      if (cents(row.remainder) > 0) return null; // lowers, and was never judged
      continue;
    }
    // The receipt's CURRENT customer, read under its row lock (the caller holds it): moved since the judgment (a merge,
    // a reassignment) → the judgment no longer describes it; never pass it on the old customer's credit.
    if (!sameId(row.customerId, snap.customerId)) return false;
    const judgedRow = snap.rows.find((r) => sameId(r.paymentId, row.paymentId));
    if (!judgedRow || cents(row.remainder) !== cents(judgedRow.remainder)) return false;
    const key = snap.customerId.toLowerCase();
    if (ctx.verified.has(key)) continue;
    await tryLockCustomerCredit(companyId, snap.customerId);
    const now = await customerCreditDays(companyId, snap.customerId, snap.rows.map((r) => ({ paymentId: r.paymentId })));
    const before = new Map(snap.days.map((d) => [d.d, cents(d.others)]));
    for (const d of new Set([...before.keys(), ...now.days.map((x) => x.d)])) {
      const was = before.get(d) ?? 0;
      const is = cents(now.days.find((x) => x.d === d)?.others ?? 0);
      if (is < was) return false;
    }
    const nowRows = await removedRows(companyId, snap.rows.map((r) => ({ paymentId: r.paymentId })));
    const judgedRemainder = (id: string) => snap.rows.find((r) => sameId(r.paymentId, id))?.remainder;
    if (nowRows.some((n) => {
      const was = judgedRemainder(n.paymentId);
      return !sameId(n.customerId, snap.customerId) || was === undefined || cents(n.remainder) !== cents(was);
    })) return false;
    ctx.verified.add(key);
  }
  return true;
}

const changedMeanwhile = () => new ReceiptRefusal('This customer\'s account changed while the reversal was running — '
  + 'nothing was reversed; retry in a moment.', { retryable: true });

/** Refuses (RECEIPT_REFUSED, before any write) cancelling `paymentIds` when it would leave a refund uncovered. */
export async function assertReceiptVoidKeepsCredit(companyId: string, paymentIds: readonly string[]): Promise<void> {
  const verified = await verifyJudged(companyId, paymentIds);
  if (verified === true) return;
  if (verified === false) throw changedMeanwhile();
  const { shortfall } = await judge(companyId, paymentIds.map((paymentId) => ({ paymentId })), true);
  if (shortfall) throw refusal(shortfall, cancelling(paymentIds.length), CANCEL_REMEDY);
}

/** Refuses (RECEIPT_REFUSED, before any write) applying `amount` of an EXISTING receipt's remainder a refund spent. */
export async function assertReceiptApplicationKeepsCredit(companyId: string, paymentId: string, amount: number): Promise<void> {
  const { shortfall } = await judge(companyId, [{ paymentId, amount }], true);
  if (shortfall) {
    throw refusal(shortfall, `Applying ${formatMoney(amount)} of this receipt`,
      'Reverse the refund first, or apply only what is still on account.');
  }
}

/**
 * The bulk judgment, read-only (no lock): refuses cancelling `paymentIds` together as the live bulk call will. A dry
 * run answers with this; the live call runs the same judgment through `withReceiptCancellationsJudged`.
 */
export async function judgeReceiptCancellations(companyId: string, paymentIds: readonly string[]) {
  const { shortfall, snapshots } = await judge(companyId, paymentIds.map((paymentId) => ({ paymentId })), false);
  if (shortfall) throw refusal(shortfall, cancelling(paymentIds.length), CANCEL_REMEDY);
  return snapshots;
}

/**
 * Judge `paymentIds` together ONCE, then run `fn` with every per-receipt check inside it verifying that judgment
 * instead of judging again. `locked`: take each customer's lock for the judgment (a caller holding the receipts and
 * their invoices already); a bulk call judges unlocked, before it holds any line, exactly as its dry run does, and
 * the customer is locked at each receipt's own step. Inside an outer judgment that already covers `paymentIds`, the
 * outer one stands.
 */
export async function withReceiptCancellationsJudged<T>(
  companyId: string, paymentIds: readonly string[], fn: () => Promise<T>, opts: { locked?: boolean; reAdd?: CreditReAdd } = {},
): Promise<T> {
  if (paymentIds.length === 0) return fn();
  const verified = await verifyJudged(companyId, paymentIds);
  if (verified === true) return fn();
  if (verified === false) throw changedMeanwhile();
  const { shortfall, snapshots } = await judge(companyId, paymentIds.map((paymentId) => ({ paymentId })), opts.locked === true, opts.reAdd);
  if (shortfall) throw refusal(shortfall, cancelling(paymentIds.length), CANCEL_REMEDY);
  return judged.run({ companyId, snapshots: new Map(snapshots.map((x) => [x.customerId, x])), verified: new Set() }, fn);
}
