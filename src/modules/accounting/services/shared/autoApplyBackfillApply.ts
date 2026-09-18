/**
 * Applying ONE unapplied source during a live back-fill.
 *
 * Split from the orchestrator so that the run's control flow — savepoint per
 * source, failures reported rather than fatal — is readable apart from the
 * ledger rules for one payment. Both throw rather than return a failure: the
 * caller's savepoint is what rolls a half-applied source back, and a caught
 * error inside here would leave one behind.
 *
 * NO JOURNAL POSTS FROM ANYTHING BELOW. The cash is already in the ledger;
 * these move the subledger into agreement with it.
 */

import { log } from '@/lib/logger';
import {
  lockCustomerPaymentForUpdate,
  lockSupplierPaymentForUpdate,
} from '../core/paymentLock';
import {
  planSupplierPaymentApplication,
  applySupplierPaymentPlan,
} from '../ap/supplierPaymentApplicationService';
import { planReceiptApplication, applyReceiptPlan } from '../ar/receiptApplicationService';
import { resolveSupplierAutoAllocateStrategy } from '../ap/supplierAutoAllocate';
import { resolveCustomerAutoAllocateStrategy } from '../ar/customerAutoAllocate';
import { journalIsInAPeriod } from './journalPeriodVisibility';
import { EPS, planGreedyAllocations, round2 } from './autoAllocateStrategy';
import { fetchOpenDocuments } from './autoApplyBackfillPopulation';
import { applyCreditNoteRemainder } from './autoApplyBackfillCreditNote';
import type { BackfillSource, PlannedLine, Subledger } from './autoApplyBackfillPlan';

/** What both application plans have in common, which is all this file reads. */
interface AppliedPlan {
  lines: readonly { invoiceId: string; invoiceNumber: string; amount: number }[];
  allocatedBefore: number;
  allocatedAfter: number;
  unappliedAfter: number;
}

export interface ApplyContext {
  companyId: string;
  subledger: Subledger;
  userId: string;
  idempotencyKey: string | null;
  /** True unless the contact asked for newest-first. Cached by the caller. */
  oldestFirstFor: (entityId: string) => Promise<boolean>;
}

/** Each contact's direction preference, read once however many sources it has. */
export function makeStrategyReader(
  companyId: string, subledger: Subledger,
): (entityId: string) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (entityId: string) => {
    const hit = cache.get(entityId);
    if (hit !== undefined) return hit;
    const strategy = subledger === 'ap'
      ? await resolveSupplierAutoAllocateStrategy(companyId, entityId)
      : await resolveCustomerAutoAllocateStrategy(companyId, entityId);
    // 'off' means NO PREFERENCE here, exactly as it does for the per-call
    // auto-apply mode: only an explicit 'newest' flips the direction.
    const oldestFirst = strategy !== 'newest';
    cache.set(entityId, oldestFirst);
    return oldestFirst;
  };
}

/**
 * Apply one payment's remainder. Returns the lines written, EMPTY when there
 * was nothing open to take it — a normal outcome, not a failure.
 *
 * The remainder is re-read here, under the payment's own row lock, rather than
 * trusted from the population read: cash applied in between would otherwise be
 * spent twice, and the plan would refuse the whole payment for an
 * over-allocation the run could simply have avoided.
 */
export async function applyOnePayment(
  ctx: ApplyContext,
  source: BackfillSource,
): Promise<PlannedLine[]> {
  const isAp = ctx.subledger === 'ap';
  const payment = isAp
    ? await lockSupplierPaymentForUpdate(ctx.companyId, source.paymentId)
    : await lockCustomerPaymentForUpdate(ctx.companyId, source.paymentId);
  if (!payment) throw new Error(`Payment ${source.paymentId} not found`);

  const remainder = round2(Number(payment.total_amount) - Number(payment.allocated_amount ?? 0));
  if (remainder <= EPS) return [];

  // A document must not be marked paid off a journal that appears in no
  // period-scoped report — the guard the live FIFO path applies before it
  // applies anything (shared/journalPeriodVisibility). A posted payment with no
  // journal at all is a data fault, so it is left alone rather than guessed at.
  const journalEntryId = payment.gl_journal_entry_id
    ? String(payment.gl_journal_entry_id)
    : null;
  if (!journalEntryId || !(await journalIsInAPeriod(ctx.companyId, journalEntryId))) return [];

  // LOCKED: this call is about to consume these rows.
  const open = await fetchOpenDocuments(
    ctx.companyId, ctx.subledger, source.entityId,
    await ctx.oldestFirstFor(source.entityId), true,
  );
  const allocations = planGreedyAllocations(remainder, open);
  if (allocations.length === 0) return [];

  // plan → apply, the split both application services enforce: the plan takes
  // the row lock and runs every guard, the apply writes and guards nothing.
  let plan: AppliedPlan;
  if (isAp) {
    const p = await planSupplierPaymentApplication(ctx.companyId, source.paymentId, allocations);
    await applySupplierPaymentPlan(ctx.companyId, p, ctx.userId);
    plan = p;
  } else {
    const p = await planReceiptApplication(ctx.companyId, source.paymentId, allocations);
    await applyReceiptPlan(ctx.companyId, p, ctx.userId);
    plan = p;
  }

  log.info('Back-fill applied unapplied cash', {
    subledger: ctx.subledger,
    paymentId: source.paymentId,
    paymentNumber: source.paymentNumber,
    entityId: source.entityId,
    lines: plan.lines.length,
    applied: round2(plan.allocatedAfter - plan.allocatedBefore),
    onAccountAfter: plan.unappliedAfter,
    idempotencyKey: ctx.idempotencyKey,
    userId: ctx.userId,
  }, 'accounting');

  return plan.lines.map((l) => ({
    document_id: l.invoiceId,
    document_number: l.invoiceNumber,
    // Filled in by the caller, in one statement for the whole run.
    invoice_date: null,
    amount: l.amount,
  }));
}

/**
 * Apply one credit note's unused remainder.
 *
 * The open documents are NOT read here. That fetch takes row locks and must
 * happen AFTER the note's own lock — see the lock-order note in
 * autoApplyBackfillCreditNote — so it lives inside the applier, which is the
 * only place that can guarantee the order. The population's remainder is not
 * passed on either: the applier re-derives it under the lock.
 */
export async function applyOneCreditNote(
  ctx: ApplyContext,
  source: BackfillSource,
): Promise<PlannedLine[]> {
  return applyCreditNoteRemainder({
    companyId: ctx.companyId,
    subledger: ctx.subledger,
    creditNoteId: source.paymentId,
    oldestFirst: await ctx.oldestFirstFor(source.entityId),
    userId: ctx.userId,
  });
}
