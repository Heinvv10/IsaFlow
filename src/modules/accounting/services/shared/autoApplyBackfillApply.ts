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
import { sql } from '@/lib/neon';
import { EPS, planGreedyAllocations, round2 } from './autoAllocateStrategy';
import { lockCreditNoteForUpdate } from '../ar/creditNoteLock';
import { assertStoredDocumentSettleable } from './documentCurrency';
import { applyCreditNote, deriveCreditNoteStatus } from './creditNoteFifo';
import { fetchOpenDocuments } from './autoApplyBackfillPopulation';
import type { BackfillSource, PlannedLine, Subledger } from './autoApplyBackfillPlan';

/**
 * Statuses a credit note may still be applied FROM. 'applied' and 'cancelled'
 * are terminal for this purpose, and 'draft' has no journal behind it yet.
 */
export const APPLICABLE_CREDIT_NOTE_STATUSES: ReadonlySet<string> = new Set(['approved', 'partially_applied']);

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

  // NO FISCAL-PERIOD CHECK HERE. It used to live at this line and NOWHERE else,
  // which meant a payment whose journal is in no period was planned as applying
  // and then silently withheld — the dry run and the live run disagreeing about
  // that payment AND about every later payment against the same contact, whose
  // balances the phantom application had consumed. The guard now belongs to the
  // population (`markJournalPeriodSkips`), where one decision serves both modes.
  // A second copy here could only drift from it.
  //
  // `entityId` is non-null by the same route: a source without one is skipped
  // in the population and never reaches an applier.
  const entityId = source.entityId!;
  // LOCKED: this call is about to consume these rows.
  const open = await fetchOpenDocuments(
    ctx.companyId, ctx.subledger, entityId, await ctx.oldestFirstFor(entityId), true,
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
    entityId,
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
 * Apply one credit note's unused remainder, THROUGH L2'S WRITER.
 *
 * This used to have a writer of its own, and that was the defect: rows written
 * by a second implementation are rows `cancelCreditNote` was not built to give
 * back. `shared/creditNoteFifo.applyCreditNote` is the one path that locks the
 * candidate documents before planning, writes `credit_note_allocations`, and
 * refuses a note whose column and rows already disagree — so a note this
 * back-fill applies is cancellable by exactly the same code as a note the
 * approval applied. `applied_amount` and the status are set here because the
 * writer deliberately leaves them to its caller, and the status is DERIVED from
 * what was consumed rather than chosen.
 *
 * WHAT IS PASSED, and why each one:
 *   · `totalAmount` is the REMAINDER, not the note's face value — the note is
 *     already approved and this is only what is left of it.
 *   · `linkedInvoiceId` is null. The link was honoured at approval; naming it
 *     again would plan a second application against the same pair and raise
 *     23505 on the allocation table's UNIQUE.
 *   · `alreadyApplied` is what the column says, which is what
 *     `assertAllocationsMatchApplied` checks the rows against before writing.
 */
export async function applyOneCreditNote(
  ctx: ApplyContext,
  source: BackfillSource,
): Promise<PlannedLine[]> {
  // THE NOTE FIRST. `applyCreditNote` locks the documents, and the cancel and
  // apply paths both take the note before its documents; acquiring them the
  // other way round here would be a reachable deadlock (40P01) against either.
  const note = await lockCreditNoteForUpdate(ctx.companyId, source.paymentId);
  if (!note) throw new Error(`Credit note ${source.paymentId} not found`);

  // Re-derived from the LOCKED row, never from the population's figure: two
  // runs that both spent a remainder read before either started would consume
  // the note for twice its own total.
  const appliedBefore = round2(Number(note.applied_amount ?? 0));
  const total = round2(Number(note.total_amount));
  const remainder = round2(total - appliedBefore);

  // THE REMAINDER IS TESTED BEFORE THE STATUS. A note another run has just
  // finished is at 'applied' with nothing left: that is no work to do, not a
  // fault, and reporting it as one would make every second pass read as broken.
  // A note with money still on it whose status has moved is the real refusal —
  // cancelling resets `applied_amount` to 0, so a cancelled note arrives with
  // its whole total apparently available and must never be spent.
  if (remainder <= EPS) return [];
  // FX PR0: the population leaves a foreign note out; one reaching here (a direct caller) is refused by name.
  await assertStoredDocumentSettleable(ctx.companyId, 'credit_note', source.paymentId);
  const status = String(note.status);
  if (!APPLICABLE_CREDIT_NOTE_STATUSES.has(status)) {
    throw new Error(
      `Credit note ${source.paymentId} is "${status}" and can no longer be applied — `
      + 'it changed after this run read it.',
    );
  }

  const side = ctx.subledger === 'ap' ? 'supplier' as const : 'customer' as const;
  const application = await applyCreditNote({
    companyId: ctx.companyId,
    creditNoteId: source.paymentId,
    side,
    entityId: source.entityId!,
    totalAmount: remainder,
    linkedInvoiceId: null,
    autoApply: 'fifo',
    alreadyApplied: appliedBefore,
  });
  if (application.lines.length === 0) return [];

  const appliedAfter = round2(appliedBefore + application.appliedAmount);
  await sql`
    UPDATE credit_notes
    SET applied_amount = ${appliedAfter},
        status = ${deriveCreditNoteStatus(appliedAfter, total)},
        updated_at = NOW()
    WHERE id = ${source.paymentId}::UUID AND company_id = ${ctx.companyId}::UUID
  `;

  log.info('Back-fill applied credit note remainder', {
    creditNoteId: source.paymentId,
    subledger: ctx.subledger,
    lines: application.lines.length,
    applied: application.appliedAmount,
    appliedAfter,
    idempotencyKey: ctx.idempotencyKey,
    userId: ctx.userId,
  }, 'accounting');

  // The document NUMBER is not something the writer returns, and re-reading it
  // per line would be a query each. The caller fills both it and the date in
  // one statement for the whole run.
  return application.lines.map((l) => ({
    document_id: l.invoiceId,
    document_number: '',
    invoice_date: null,
    amount: l.amount,
  }));
}
