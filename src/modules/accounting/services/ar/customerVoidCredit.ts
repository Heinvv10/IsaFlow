/**
 * The refusal every write that REMOVES unapplied receipt cash makes before its first write: a
 * cancellation of a customer receipt and an application of an existing receipt's remainder. Either would be refused
 * when it leaves the customer's running on-account credit below zero on a date it lowers (`ar/customerRunningCredit`:
 * the rule, by date) — a refund already returned that cash. The AR twin of `ap/supplierVoidCredit`. A refund is judged
 * by the very same rule (`ar/customerRefundDocument.planCustomerRefund`: it takes its amount off from its own date on),
 * so the three writes that lower the credit agree. Judged by date, never on the all-dates figure: a receipt dated after
 * the refund must not hide it.
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
 * has moved since (the receipt still the judged customer's, with its judged remainder; the other rows' figures not
 * fallen on any date and no judged row moved — at every receipt) — a refusal there is retryable, never a second
 * opinion on the books. A reallocation to the SAME customer defers that customer and judges it on the rows its write
 * actually leaves (`customerCreditFall`, after the new receipt and its FIFO), inside the write's savepoint.
 *
 * Residual: an UNAPPLY (raises credit) takes no customer lock; harmless, it only makes a read conservative.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { tryLockCustomerCredit } from './customerCreditLock';
import { customerCreditDays, dayKey, judgeCreditDays, lowersBelowZero, type CreditDay, type CreditRemoval } from './customerRunningCredit';
import { cents } from './receiptInvoiceLock';
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

/**
 * Judge `removals` per customer; the first shortfall, and what each customer's judgment read. `deferred`: a customer
 * the caller judges itself on the rows its write actually leaves (`customerCreditFall`), so it is not judged here.
 */
async function judge(companyId: string, removals: readonly CreditRemoval[], lock: boolean, deferred?: string) {
  const snapshots: CustomerSnapshot[] = [];
  for (const [customerId, rows] of byCustomer(await removedRows(companyId, removals))) {
    if (rows.every((r) => cents(r.removes) <= 0)) continue; // lowers nothing: no lock, never refused
    if (deferred && sameId(deferred, customerId)) continue;
    if (lock) await tryLockCustomerCredit(companyId, customerId);
    const { customerName, days } = await customerCreditDays(companyId, customerId,
      rows.map((r) => ({ paymentId: r.paymentId, amount: r.removes })));
    snapshots.push({ customerId, days, rows });
    const j = judgeCreditDays(days);
    if (lowersBelowZero(j) && j.fromDate) {
      const shortfall: CustomerVoidCreditShortfall = { customerId, customerName, lowers: j.lowers, credit: j.lowest, fromDate: j.fromDate };
      return { shortfall, snapshots };
    }
  }
  return { shortfall: null, snapshots };
}

/**
 * The first customer whose credit cancelling `paymentIds` would take below zero on a date it lowers, or null.
 * `deferredCustomerId`: left to the caller's own judgment of what its write actually leaves (`customerCreditFall`).
 */
export async function customerVoidCreditShortfall(
  companyId: string, paymentIds: readonly string[], deferredCustomerId?: string,
): Promise<CustomerVoidCreditShortfall | null> {
  return (await judge(companyId, paymentIds.map((paymentId) => ({ paymentId })), true, deferredCustomerId)).shortfall;
}

/**
 * Judged on REAL rows, after a write: did the write take `customerId`'s running credit below zero on a date it
 * lowered? `before` is the customer's per-day figures read under its lock before the write; the write's removal on
 * each date is what it took off (before − now). A reallocation to the same customer judges this way, after its new
 * receipt and FIFO have landed, inside its savepoint — no prediction of what FIFO will apply.
 */
export async function customerCreditFall(
  companyId: string, customerId: string, before: readonly CreditDay[],
): Promise<CustomerVoidCreditShortfall | null> {
  const now = await customerCreditDays(companyId, customerId, []);
  const was = new Map(before.map((d) => [dayKey(d.d), d.amount]));
  const is = new Map(now.days.map((d) => [dayKey(d.d), d.amount]));
  const days = [...new Set([...was.keys(), ...is.keys()])].map((d) => {
    const removed = (was.get(d) ?? 0) - (is.get(d) ?? 0);
    return { d, amount: was.get(d) ?? 0, removed, lowers: Math.max(removed, 0), others: 0 };
  });
  const j = judgeCreditDays(days);
  if (!lowersBelowZero(j) || !j.fromDate) return null;
  return { customerId, customerName: now.customerName, lowers: j.lowers, credit: j.lowest, fromDate: j.fromDate };
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

/** A judged set: what each customer's judgment read, and the one customer the caller judges itself. */
const judged = new AsyncLocalStorage<{ companyId: string; snapshots: Map<string, CustomerSnapshot>; deferred?: string }>();

/** Where a set of receipts stands against an up-front judgment. */
type Verified = 'not-judged' | 'ok' | 'moved';

/**
 * Re-checks, under this receipt's locks and its customer's, that a set judged up front still stands: the receipt is
 * still the judged customer's with the judged remainder, and no other row of that customer has fallen on any date and
 * no judged row has moved. On EVERY call, under the customer lock taken again (re-entrant): nothing is cached between
 * receipts, so a lock released meanwhile (a set-aside line's savepoint rolled back) cannot let a stale check stand.
 * 'not-judged' when `paymentIds` are not all in a judged set (the caller then judges them itself).
 */
async function verifyJudged(companyId: string, paymentIds: readonly string[]): Promise<Verified> {
  const ctx = judged.getStore();
  if (!ctx || ctx.companyId !== companyId) return 'not-judged';
  const all = [...ctx.snapshots.values()];
  const snapOf = (id: string) => all.find((s) => s.rows.some((r) => sameId(r.paymentId, id)));
  const live = await removedRows(companyId, paymentIds.map((paymentId) => ({ paymentId })));
  for (const row of live) {
    // The caller judges this customer on the rows its write leaves (`customerCreditFall`): its CURRENT customer only.
    if (ctx.deferred && sameId(row.customerId, ctx.deferred)) continue;
    const snap = snapOf(row.paymentId);
    if (!snap) {
      if (cents(row.remainder) > 0) return 'not-judged'; // lowers, and was never judged
      continue;
    }
    // The receipt's CURRENT customer, read under its row lock (the caller holds it): moved since the judgment (a merge,
    // a reassignment) → the judgment no longer describes it; never pass it on the old customer's credit.
    if (!sameId(row.customerId, snap.customerId)) return 'moved';
    const judgedRow = snap.rows.find((r) => sameId(r.paymentId, row.paymentId));
    if (!judgedRow || cents(row.remainder) !== cents(judgedRow.remainder)) return 'moved';
    await tryLockCustomerCredit(companyId, snap.customerId);
    if (!(await customerStillAsJudged(companyId, snap))) return 'moved';
  }
  return 'ok';
}

/** The customer's other rows have not fallen on any date, and the judged rows are where the judgment left them. */
async function customerStillAsJudged(companyId: string, snap: CustomerSnapshot): Promise<boolean> {
  const now = await customerCreditDays(companyId, snap.customerId, snap.rows.map((r) => ({ paymentId: r.paymentId })));
  const before = new Map(snap.days.map((d) => [d.d, cents(d.others)]));
  for (const d of new Set([...before.keys(), ...now.days.map((x) => x.d)])) {
    if (cents(now.days.find((x) => x.d === d)?.others ?? 0) < (before.get(d) ?? 0)) return false;
  }
  const nowRows = await removedRows(companyId, snap.rows.map((r) => ({ paymentId: r.paymentId })));
  return nowRows.every((n) => {
    const was = snap.rows.find((r) => sameId(r.paymentId, n.paymentId))?.remainder;
    return sameId(n.customerId, snap.customerId) && was !== undefined && cents(n.remainder) === cents(was);
  });
}

const changedMeanwhile = () => new ReceiptRefusal('This customer\'s account changed while the reversal was running — '
  + 'nothing was reversed; retry in a moment.', { retryable: true });

/**
 * The cancellation check, both ways in: inside a judgment that covers `paymentIds` it only verifies (and refuses,
 * retryable, when something moved); outside one it judges them, refusing on the figures. Returns the new judgment's
 * snapshots when it made one.
 */
async function judgeOrVerify(
  companyId: string, paymentIds: readonly string[], lock: boolean, deferred?: string,
): Promise<{ verified: true } | { verified: false; snapshots: CustomerSnapshot[] }> {
  const v = await verifyJudged(companyId, paymentIds);
  if (v === 'ok') return { verified: true };
  if (v === 'moved') throw changedMeanwhile();
  const { shortfall, snapshots } = await judge(companyId, paymentIds.map((paymentId) => ({ paymentId })), lock, deferred);
  if (shortfall) throw refusal(shortfall, cancelling(paymentIds.length), CANCEL_REMEDY);
  return { verified: false, snapshots };
}

/** Refuses (RECEIPT_REFUSED, before any write) cancelling `paymentIds` when it would leave a refund uncovered. */
export async function assertReceiptVoidKeepsCredit(companyId: string, paymentIds: readonly string[]): Promise<void> {
  await judgeOrVerify(companyId, paymentIds, true);
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
  companyId: string, paymentIds: readonly string[], fn: () => Promise<T>,
  opts: { locked?: boolean; deferredCustomerId?: string } = {},
): Promise<T> {
  if (paymentIds.length === 0) return fn();
  const r = await judgeOrVerify(companyId, paymentIds, opts.locked === true, opts.deferredCustomerId);
  if (r.verified) return fn();
  return judged.run({
    companyId, snapshots: new Map(r.snapshots.map((x) => [x.customerId, x])),
    ...(opts.deferredCustomerId ? { deferred: opts.deferredCustomerId } : {}),
  }, fn);
}
