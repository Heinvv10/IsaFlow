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
  invoiceFloor,
  parseAutoAllocateStrategy,
  planGreedyAllocations,
  resolveApplicationOrder,
  round2,
  type AutoAllocateStrategy,
  type AutoApplyMode,
} from '../shared/autoAllocateStrategy';
import { fetchOpenCustomerInvoices } from './openCustomerInvoices';

// Re-exported for the same reason as the AP twin: the fetch moved so its LOCK
// could become the caller's choice, not because this stopped being its home.
export { fetchOpenCustomerInvoices };

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

  // Locked: this call is about to consume these rows.
  const open = await fetchOpenCustomerInvoices(
    companyId, customerId, strategy === 'oldest', { forUpdate: true },
  );
  const allocations = planGreedyAllocations(amount, open, invoiceFloor('customer'));
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
