/**
 * The AR twin of `ap/supplierAutoAllocate`: applying a bank RECEIPT to the
 * customer's open invoices when the customer's `auto_allocate_strategy` says
 * to.
 *
 * Only half the AP problem exists on this side. `allocateTransaction` with
 * `allocType='customer'` already inserts a `customer_payments` row, so the cash
 * has a document and `list_unapplied_receipts` can find it — that is why the
 * unapplied receipts balance is a KNOWN, growing number rather than an
 * invisible one. What was missing is the same as on AP: the customer's stated
 * instruction to apply it was written to a column nothing read.
 *
 * NO JOURNAL POSTS HERE. `allocateTransaction` posted DR Bank / CR Accounts
 * Receivable for the whole line; this moves the subledger into agreement with
 * it. Nothing is caught — see the header of the AP twin for why a caught error
 * after a write is worse than a rollback.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  planReceiptApplication,
  applyReceiptPlan,
} from './receiptApplicationService';
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
 * Statuses that cannot take a receipt — the set `receiptAllocationLines`
 * refuses on, plus the terminal ones.
 *
 * 'disputed' and 'written_off' are NOT in `customer_invoices`' CHECK constraint
 * (migration 000; a dispute lives in `customer_invoice_disputes` instead), so
 * neither ever matches a row. They are listed anyway so this array and its AP
 * twin say the same thing: two lists that disagree about what cash may settle
 * is how the two subledgers drift apart.
 */
const UNALLOCATABLE_STATUSES = [
  'draft', 'pending_approval', 'cancelled', 'paid', 'written_off', 'disputed',
];

export interface CustomerReceiptApplication {
  appliedLines: { invoiceId: string; invoiceNumber: string; amount: number }[];
  unappliedRemainder: number;
  /** The order the cash was consumed in, or 'off' when none of it was. */
  strategy: AutoAllocateStrategy;
  /** The mode this call ran under. */
  autoApply: AutoApplyMode;
}

/** The customer's instruction, or 'off' when the customer row has gone. */
export async function resolveCustomerAutoAllocateStrategy(
  companyId: string,
  customerId: string,
): Promise<AutoAllocateStrategy> {
  const rows = (await sql`
    SELECT auto_allocate_strategy FROM customers
    WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return parseAutoAllocateStrategy(rows[0]?.auto_allocate_strategy) ?? 'off';
}

/**
 * The customer's open invoices in the order the cash will consume them, LOCKED.
 *
 * `COALESCE(ci.client_id, ci.customer_id)` because both columns exist and
 * either can carry the customer — matching on one alone silently misses half
 * the ledger.
 *
 * `FOR UPDATE OF ci` and not a bare `FOR UPDATE`: the lock is on the invoice
 * rows this receipt is about to consume, and without it two concurrent
 * receipts read the same open invoice and each applies its whole amount to it.
 */
export async function fetchOpenCustomerInvoices(
  companyId: string,
  customerId: string,
  oldestFirst: boolean,
): Promise<SimulationDocument[]> {
  const rows = (oldestFirst
    ? await sql`
        SELECT ci.id, ci.invoice_number,
               (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding
        FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID
          AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
          AND ci.deleted_at IS NULL
          AND ci.status <> ALL(${UNALLOCATABLE_STATUSES}::TEXT[])
          AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > ${EPS}
        ORDER BY ci.invoice_date ASC, ci.due_date ASC NULLS LAST, ci.id ASC
        FOR UPDATE OF ci`
    : await sql`
        SELECT ci.id, ci.invoice_number,
               (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding
        FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID
          AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
          AND ci.deleted_at IS NULL
          AND ci.status <> ALL(${UNALLOCATABLE_STATUSES}::TEXT[])
          AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > ${EPS}
        ORDER BY ci.invoice_date DESC, ci.due_date DESC NULLS FIRST, ci.id DESC
        FOR UPDATE OF ci`) as DbRow[];
  return rows.map((r) => ({
    invoiceId: String(r.id),
    invoiceNumber: r.invoice_number ? String(r.invoice_number) : String(r.id),
    outstanding: Number(r.outstanding),
  }));
}

/**
 * Apply a receipt that is already in the ledger, if the customer asked for it.
 * A no-op returning an empty application when the strategy is 'off' or nothing
 * is open — the receipt then stays unapplied, which is what
 * `list_unapplied_receipts` reports.
 */
export async function autoApplyCustomerReceipt(args: {
  companyId: string;
  customerId: string;
  paymentId: string;
  /** The journal this receipt posted on — checked for a fiscal period. */
  journalEntryId: string;
  amount: number;
  userId: string;
  /**
   * `'none'` when the caller has already named what this cash settles — see the
   * AP twin. Defaults to `'fifo'`.
   */
  autoApply?: AutoApplyMode;
}): Promise<CustomerReceiptApplication> {
  const { companyId, customerId, paymentId, journalEntryId, amount, userId } = args;
  const autoApply = args.autoApply ?? DEFAULT_AUTO_APPLY;

  // Mode first, customer second, journal third — the same ordering and the same
  // reason as the AP twin: a caller that said 'none' must not cost either read,
  // and the period read only has to answer for cash that is about to be
  // applied.
  //
  // See journalPeriodVisibility: an invoice must not be marked paid off a
  // journal that appears in no period-scoped report.
  const requested = autoApply === 'none'
    ? null
    : resolveApplicationOrder(
      autoApply, await resolveCustomerAutoAllocateStrategy(companyId, customerId),
    );
  const strategy = requested !== null && await journalIsInAPeriod(companyId, journalEntryId)
    ? requested
    : 'off';
  if (strategy === 'off') {
    return { appliedLines: [], unappliedRemainder: round2(amount), strategy, autoApply };
  }

  const open = await fetchOpenCustomerInvoices(companyId, customerId, strategy === 'oldest');
  const allocations = planGreedyAllocations(amount, open);
  if (allocations.length === 0) {
    log.info('Customer receipt recorded, no open invoice to apply to', {
      customerId, paymentId, amount, strategy,
    }, 'accounting');
    return { appliedLines: [], unappliedRemainder: round2(amount), strategy, autoApply };
  }

  const plan = await planReceiptApplication(companyId, paymentId, allocations);
  await applyReceiptPlan(companyId, plan, userId);

  log.info('Customer receipt auto-applied', {
    customerId, paymentId, strategy,
    lines: plan.lines.length,
    applied: round2(plan.allocatedAfter - plan.allocatedBefore),
    unappliedRemainder: plan.unappliedAfter,
  }, 'accounting');

  return {
    appliedLines: plan.lines.map((l) => ({
      invoiceId: l.invoiceId, invoiceNumber: l.invoiceNumber, amount: l.amount,
    })),
    unappliedRemainder: plan.unappliedAfter,
    strategy,
    autoApply,
  };
}
