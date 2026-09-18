/**
 * The supplier payment DOCUMENT a bank allocation never created, and the
 * optional automatic application of it.
 *
 * ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────
 *
 * `allocateTransaction` with `allocType='customer'` inserts a
 * `customer_payments` row alongside its journal. With `allocType='supplier'` it
 * inserted NOTHING: it posted DR Accounts Payable / CR Bank, then picked the
 * supplier's most recently CREATED unpaid bill and called `recordPaymentMatch`
 * on it — a `payment_matched` boolean, with `amount_paid` and `status`
 * untouched, on a bill the caller never named.
 *
 * So the cash existed only as a journal line. No payment document meant nothing
 * to reconcile the bill against, nothing for `apply_supplier_payment` to take,
 * and nothing for any listing to find — while an arbitrary bill carried a flag
 * claiming it had been settled at `amount_paid = 0`.
 *
 * ── WHAT HAPPENS NOW ────────────────────────────────────────────────────────
 *
 * Every supplier allocation that does not name a bill creates a
 * `supplier_payments` row at status `processed`, carrying the journal the
 * allocation just posted. Then, and only if the supplier's
 * `auto_allocate_strategy` says so, the payment is applied to that supplier's
 * open bills oldest-first or newest-first, partially settling the one the money
 * runs out on. The default is 'off': the document is created and left
 * unapplied, which is a visible, correctable state rather than a silent one.
 *
 * NO SECOND JOURNAL IS POSTED HERE. `allocateTransaction` posted the only one;
 * `applySupplierPaymentPlan` moves the subledger and nothing else. Posting
 * again would double the payment.
 *
 * ── WHY IT DOES NOT LIVE IN allocateTransaction ─────────────────────────────
 *
 * `applyBankLineToSupplierInvoices` calls `allocateTransaction` itself, passing
 * the bill it is settling. That is the discriminator: a call that NAMES an
 * invoice already has a document writer above it and must not get a second one
 * here. `allocateTransaction` therefore calls in here only when no invoice was
 * named, and stays a journal poster.
 *
 * ── FAILURE IS NOT CAUGHT ───────────────────────────────────────────────────
 *
 * Everything below runs after the journal has posted, inside the request's
 * transaction. A throw unwinds the journal with it, which is the correct
 * outcome. Catching it would commit a half-applied payment under a success
 * response — the shape that produced the defects in the first place.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import {
  planSupplierPaymentApplication,
  applySupplierPaymentPlan,
} from './supplierPaymentApplicationService';
import { journalIsInAPeriod } from '../shared/journalPeriodVisibility';
import {
  DEFAULT_AUTO_APPLY,
  EPS,
  parseAutoAllocateStrategy,
  planGreedyAllocations,
  resolveApplicationOrder,
  round2,
  type AutoAllocateStrategy,
  type AutoApplyMode,
} from '../shared/autoAllocateStrategy';
import type { SimulationDocument } from '../shared/autoApplySimulation';

/**
 * Bill statuses that cannot take a payment. Deliberately the same set
 * `supplierAllocationLines#buildLine` refuses on, plus the terminal ones there
 * is no point selecting: an auto-allocation that planned a line the applier
 * then threw on would roll back a journal over a bill nobody asked to pay.
 *
 * 'disputed' is in `supplier_invoices`' CHECK constraint (migration 201) and is
 * the one the automatic path most needs: cash must not quietly settle a bill
 * the company is contesting. 'written_off' is not in that constraint and so
 * never matches — kept because the AR twin's table does carry it and one list
 * that is wrong in the harmless direction beats two lists that disagree.
 */
const UNALLOCATABLE_STATUSES = ['draft', 'cancelled', 'paid', 'written_off', 'disputed'];

export interface SupplierBankPaymentDocument {
  paymentId: string;
  /** Bills this payment was automatically applied to. Empty when none was. */
  appliedLines: { invoiceId: string; invoiceNumber: string; amount: number }[];
  unappliedRemainder: number;
  /** The order the cash was consumed in, or 'off' when none of it was. */
  strategy: AutoAllocateStrategy;
  /** The mode this call ran under. */
  autoApply: AutoApplyMode;
}

/** The supplier's stated preference, or 'off' (no preference) when unreadable. */
export async function resolveSupplierAutoAllocateStrategy(
  companyId: string,
  supplierId: string,
): Promise<AutoAllocateStrategy> {
  const rows = (await sql`
    SELECT auto_allocate_strategy FROM suppliers
    WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  // An unreadable or absent value is 'off', never a guess: applying cash to
  // bills nobody named is the one outcome that must require an instruction.
  return parseAutoAllocateStrategy(rows[0]?.auto_allocate_strategy) ?? 'off';
}

/**
 * The supplier's open bills in the order the cash will consume them, LOCKED.
 *
 * `total_amount - COALESCE(amount_paid, 0)` rather than the generated `balance`
 * column: the same arithmetic every other outstanding figure in this codebase
 * is derived from, so an auto-allocation cannot disagree with the aging report
 * about what is open.
 *
 * FOR UPDATE holds every candidate row for the rest of the request. Without it
 * two concurrent payments to one supplier read the same open bill, each plans
 * its whole amount against it, and the bill ends at twice its own total — the
 * second application is not refused because nothing it read had changed.
 *
 * The tie-breakers are part of the contract, not decoration. `invoice_date`
 * alone leaves same-day bills in heap order, so "oldest first" would mean
 * "whichever row the planner happened to reach first" and two runs over the
 * same books could settle different bills.
 */
export async function fetchOpenSupplierBills(
  companyId: string,
  supplierId: string,
  oldestFirst: boolean,
): Promise<SimulationDocument[]> {
  // Two statements rather than an interpolated ORDER BY: the direction is the
  // only thing that varies and it must never be built from a string.
  const rows = (oldestFirst
    ? await sql`
        SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0)) AS outstanding
        FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID
          AND supplier_id = ${supplierId}::UUID
          AND deleted_at IS NULL
          AND status <> ALL(${UNALLOCATABLE_STATUSES}::TEXT[])
          AND (total_amount - COALESCE(amount_paid, 0)) > ${EPS}
        ORDER BY invoice_date ASC, due_date ASC NULLS LAST, id ASC
        FOR UPDATE`
    : await sql`
        SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0)) AS outstanding
        FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID
          AND supplier_id = ${supplierId}::UUID
          AND deleted_at IS NULL
          AND status <> ALL(${UNALLOCATABLE_STATUSES}::TEXT[])
          AND (total_amount - COALESCE(amount_paid, 0)) > ${EPS}
        ORDER BY invoice_date DESC, due_date DESC NULLS FIRST, id DESC
        FOR UPDATE`) as DbRow[];
  return rows.map((r) => ({
    invoiceId: String(r.id),
    invoiceNumber: r.invoice_number ? String(r.invoice_number) : String(r.id),
    outstanding: Number(r.outstanding),
  }));
}

/**
 * Create the payment document for a supplier bank line, and apply it when the
 * supplier says to.
 *
 * `journalEntryId` is the journal the caller has ALREADY posted for this line —
 * the payment carries it so the pair can be reversed together.
 */
export async function recordSupplierBankPayment(args: {
  companyId: string;
  supplierId: string;
  bankTxId: string;
  bankAccountId: string;
  journalEntryId: string;
  /** The absolute value of the bank line. */
  amount: number;
  paymentDate: string;
  description: string;
  userId: string;
  /**
   * `'none'` when the caller has already said what this cash settles — the
   * `bank-match-confirm` purchase-order branch, for one. The document is still
   * created; nothing is applied. Applying the money to a bill the caller did
   * not name would contradict the match they just confirmed.
   *
   * Defaults to `'fifo'`: a line with no named target is exactly what the mode
   * exists to decide, and leaving it unapplied is what put every one of these
   * payments at allocated 0.
   */
  autoApply?: AutoApplyMode;
}): Promise<SupplierBankPaymentDocument> {
  const {
    companyId, supplierId, bankTxId, bankAccountId, journalEntryId,
    amount, paymentDate, description, userId,
  } = args;
  const autoApply = args.autoApply ?? DEFAULT_AUTO_APPLY;

  // `created_by` is uuid-typed and NOT NULL, and a GoTrue user id is not always
  // uuid-shaped — the same trap the customer_payments insert works around.
  const createdBy = await resolveUserUuid(userId);

  const paymentRows = (await sql`
    INSERT INTO supplier_payments (
      company_id, supplier_id, payment_date, total_amount, payment_method,
      bank_account_id, reference, description, status, gl_journal_entry_id,
      created_by, approved_by, approved_at, processed_at
    ) VALUES (
      ${companyId}::UUID, ${supplierId}::UUID, ${paymentDate}::DATE,
      ${amount}, 'eft',
      ${bankAccountId}::UUID, ${bankTxId}, ${description}, 'processed',
      ${journalEntryId}::UUID,
      ${createdBy}::UUID, ${createdBy}::UUID, NOW(), NOW()
    )
    RETURNING id
  `) as DbRow[];
  const paymentId = String(paymentRows[0]!.id);

  // THE MODE DECIDES FIRST, and the order is deliberate: a sweep of 200 lines
  // sent with `auto_apply: 'none'` must not cost 200 supplier reads and 200
  // journal reads to arrive at "apply nothing". The period check only has to
  // answer for cash that is actually about to be applied.
  //
  // A bill must not be marked paid off a journal that is in no fiscal period —
  // see journalPeriodVisibility. The document above stands either way; only the
  // application is withheld.
  const requested = autoApply === 'none'
    ? null
    : resolveApplicationOrder(
      autoApply, await resolveSupplierAutoAllocateStrategy(companyId, supplierId),
    );
  const strategy = requested !== null && await journalIsInAPeriod(companyId, journalEntryId)
    ? requested
    : 'off';
  if (strategy === 'off') {
    log.info('Supplier bank payment recorded, left unapplied', {
      bankTxId, supplierId, paymentId, amount, autoApply,
    }, 'accounting');
    return {
      paymentId, appliedLines: [], unappliedRemainder: round2(amount), strategy, autoApply,
    };
  }

  const open = await fetchOpenSupplierBills(companyId, supplierId, strategy === 'oldest');
  const allocations = planGreedyAllocations(amount, open);
  if (allocations.length === 0) {
    // Nothing open to apply to. The instruction was honoured; there was simply
    // no bill. The payment stays unapplied and visible.
    log.info('Supplier bank payment recorded, no open bill to apply to', {
      bankTxId, supplierId, paymentId, amount, strategy,
    }, 'accounting');
    return {
      paymentId, appliedLines: [], unappliedRemainder: round2(amount), strategy, autoApply,
    };
  }

  // plan → apply, the split this service pair already enforces: the plan takes
  // the payment's row lock and runs every guard, the apply writes and guards
  // nothing. Both throw rather than return, and are not caught — see header.
  const plan = await planSupplierPaymentApplication(companyId, paymentId, allocations);
  await applySupplierPaymentPlan(companyId, plan, userId);

  log.info('Supplier bank payment auto-applied', {
    bankTxId, supplierId, paymentId, strategy,
    lines: plan.lines.length,
    applied: round2(plan.allocatedAfter - plan.allocatedBefore),
    unappliedRemainder: plan.unappliedAfter,
  }, 'accounting');

  return {
    paymentId,
    appliedLines: plan.lines.map((l) => ({
      invoiceId: l.invoiceId, invoiceNumber: l.invoiceNumber, amount: l.amount,
    })),
    unappliedRemainder: plan.unappliedAfter,
    strategy,
    autoApply,
  };
}
