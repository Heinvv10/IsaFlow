/**
 * What the back-fill WOULD apply to the documents cash was never attached to,
 * and the shape both the dry run and the live run report in.
 *
 * WHY THIS EXISTS. Every unapplied payment in the books is cash that has
 * already moved the control account against a document nobody closed — the
 * state `list_unapplied_payments` reports and that the FIFO default (migration
 * 614 and the auto_apply mode) only stops PRODUCING. It does nothing about the
 * backlog already there, and in production that backlog is millions.
 *
 * SEQUENTIAL, NOT PER PAYMENT. Two payments to one supplier consume the same
 * open bills, so a plan that measured each against the opening balances would
 * promise both of them BILL-001 in full and then disagree with the run it is
 * previewing — the failure `docs/mcp/CONTRACTS.md` §6 calls worse than having
 * no dry run at all. The arithmetic is `simulateSequentialApplications`, the
 * same simulator `bulk_allocate_bank_transactions`' dry run uses, over
 * `planGreedyAllocations`, the same function the live path writes from.
 *
 * PURE. Every open document, every date and every remainder is handed in;
 * nothing here reads the database, which is what makes the plan testable
 * without one.
 *
 * NOTHING HERE POSTS A JOURNAL, and nothing it plans ever will: the cash is
 * already in the ledger. An application moves the subledger — allocation rows,
 * `amount_paid`, status — into agreement with a GL that already carries it.
 */

import { invoiceFloor, round2 } from './autoAllocateStrategy';
import {
  simulateSequentialApplications,
  type SimulationDocument,
  type SimulationLine,
} from './autoApplySimulation';

export const SUBLEDGERS = ['ap', 'ar'] as const;
export type Subledger = (typeof SUBLEDGERS)[number];

/** A supplier payment / customer receipt, or a credit note of either side. */
export type BackfillSourceKind = 'payment' | 'credit_note';

/** One piece of cash (or credit) with a remainder nobody has attached. */
export interface BackfillSource {
  kind: BackfillSourceKind;
  paymentId: string;
  paymentNumber: string;
  /** Null when the contact could not be resolved — always a skipped source. */
  entityId: string | null;
  entityName: string;
  paymentDate: string;
  /** What is left after everything already allocated. Always > EPS. */
  remainder: number;
  /**
   * The journal that put this cash on the control account. Null is itself a
   * skip: cash on a posted payment with no journal is a data fault, and a
   * document must never be marked paid off one.
   */
  journalEntryId: string | null;
  /**
   * Why this source may not be applied, or null when it may.
   *
   * DECIDED IN THE POPULATION, so both modes see the same answer. A dry run
   * that planned a payment the live run then withholds does not merely misstate
   * that payment: every later payment against the same contact inherits the
   * divergence, because the balances it plans against were consumed by an
   * application that never happened.
   *
   * A skipped source consumes NOTHING. It is reported with its whole amount
   * outstanding, so the plan never promises a later payment a document this one
   * would have taken.
   */
  skippedReason?: string | null;
}

/** One document the cash would close, in the wire shape the tool returns. */
export interface PlannedLine {
  document_id: string;
  document_number: string;
  invoice_date: string | null;
  amount: number;
}

export interface PlannedApplication {
  kind: BackfillSourceKind;
  payment_id: string;
  payment_number: string;
  entity_id: string;
  entity_name: string;
  payment_date: string;
  remainder_before: number;
  lines: PlannedLine[];
  on_account_after: number;
}

/**
 * A source the run WAS allowed to apply and found nothing open for.
 *
 * Only that. A source the run was not allowed to touch is in `skipped` with the
 * reason, and keeping the two apart is the point: an operator reading
 * `no_open_documents` is reading a list of contacts with no open documents,
 * which is a real finding about the books. Mixing in payments withheld by a
 * fiscal-period guard or an unresolvable contact would make that list say
 * something it does not mean.
 *
 * A contact that had no open document at all and one whose documents an
 * EARLIER source in this same run consumed are both here: the outcome is
 * identical — the whole amount stays on account — and splitting them would
 * invite the reader to add two numbers that are the same number.
 */
export interface UnappliedSource {
  kind: BackfillSourceKind;
  payment_id: string;
  payment_number: string;
  entity_id: string | null;
  entity_name: string;
  payment_date: string;
  amount: number;
}

/**
 * A source the run may not touch, and why. Reported IDENTICALLY by both modes —
 * that is what makes a dry run a preview rather than a guess.
 */
export interface SkippedSource extends UnappliedSource {
  reason: string;
}

export interface BackfillTotals {
  applied: number;
  left_on_account: number;
  no_open_documents_amount: number;
  payments_with_no_open_documents: number;
  skipped_amount: number;
  payments_skipped: number;
  /**
   * Every remainder this run READ, whatever became of it.
   *
   * The completeness identity, and the only figure that proves nothing was
   * dropped between the population and the plan:
   *
   *   applied + left_on_account + no_open_documents_amount + skipped_amount
   *     === population_amount
   *
   * A bucket that silently swallowed a source — the unresolvable contacts the
   * first version of this dropped with a `.filter()` — breaks it immediately.
   */
  population_amount: number;
}

export interface BackfillPlan {
  dry_run: boolean;
  subledger: Subledger;
  /** Sources considered — applications.length + no_open_documents.length. */
  processed: number;
  applications: PlannedApplication[];
  no_open_documents: UnappliedSource[];
  /** Sources the run was not allowed to touch. The same in both modes. */
  skipped: SkippedSource[];
  totals: BackfillTotals;
  /** Sources a live run could not finish, with the reason. Empty on a dry run. */
  failed: { payment_id: string; payment_number: string; error: string }[];
}

function unappliedOf(source: BackfillSource): UnappliedSource {
  return {
    kind: source.kind,
    payment_id: source.paymentId,
    payment_number: source.paymentNumber,
    entity_id: source.entityId,
    entity_name: source.entityName,
    payment_date: source.paymentDate,
    amount: round2(source.remainder),
  };
}

/**
 * Assemble the reported plan from applications that have already been decided —
 * by the simulator on a dry run, by what actually posted on a live one.
 *
 * Shared so the two runs cannot report the same outcome in two shapes: an
 * operator comparing a dry run against the live run that followed it is doing
 * the only check that proves the tool did what it said.
 */
export function assembleBackfillPlan(
  dryRun: boolean,
  subledger: Subledger,
  decided: readonly { source: BackfillSource; lines: PlannedLine[] }[],
  failed: BackfillPlan['failed'] = [],
): BackfillPlan {
  const applications: PlannedApplication[] = [];
  const noOpen: UnappliedSource[] = [];
  const skipped: SkippedSource[] = [];
  let applied = 0;
  let leftOnAccount = 0;
  let population = 0;

  for (const { source, lines } of decided) {
    population = round2(population + round2(source.remainder));

    // SKIPPED WINS over everything below. A source the run may not touch has no
    // lines by construction, and reporting it as "nothing open" would put a
    // fiscal-period refusal into a list about the state of the books.
    if (source.skippedReason) {
      skipped.push({ ...unappliedOf(source), reason: source.skippedReason });
      continue;
    }
    if (lines.length === 0) {
      noOpen.push(unappliedOf(source));
      continue;
    }
    const total = lines.reduce((sum, l) => round2(sum + l.amount), 0);
    applied = round2(applied + total);
    const onAccountAfter = round2(round2(source.remainder) - total);
    leftOnAccount = round2(leftOnAccount + onAccountAfter);
    applications.push({
      kind: source.kind,
      payment_id: source.paymentId,
      payment_number: source.paymentNumber,
      entity_id: source.entityId ?? '',
      entity_name: source.entityName,
      payment_date: source.paymentDate,
      remainder_before: round2(source.remainder),
      lines,
      on_account_after: onAccountAfter,
    });
  }

  return {
    dry_run: dryRun,
    subledger,
    processed: decided.length,
    applications,
    no_open_documents: noOpen,
    skipped,
    totals: {
      applied,
      left_on_account: leftOnAccount,
      no_open_documents_amount: noOpen.reduce((s, r) => round2(s + r.amount), 0),
      payments_with_no_open_documents: noOpen.length,
      skipped_amount: skipped.reduce((s, r) => round2(s + r.amount), 0),
      payments_skipped: skipped.length,
      population_amount: population,
    },
    failed: [...failed],
  };
}

/**
 * The dry run's half: simulate every source against balances the earlier
 * sources have already consumed, then assemble.
 *
 * `openByEntity` holds each entity's open documents OLDEST FIRST — the
 * simulator reverses its own view for a newest-first contact, and one ordering
 * for the shared pool is what keeps two payments against one entity consuming
 * the same list.
 */
export function buildBackfillPlan(args: {
  subledger: Subledger;
  sources: readonly BackfillSource[];
  openByEntity: ReadonlyMap<string, readonly SimulationDocument[]>;
  oldestFirstByEntity: ReadonlyMap<string, boolean>;
  /** Document id → invoice_date, for the lines. Absent reports as null. */
  documentDates: ReadonlyMap<string, string>;
}): BackfillPlan {
  const { subledger, sources, openByEntity, oldestFirstByEntity, documentDates } = args;

  const simLines: SimulationLine[] = sources.map((source, index) => ({
    index,
    // A skipped source applies to nothing AND consumes nothing — see the field.
    // A source with no resolvable contact has no pool to consume either.
    entityKey: source.skippedReason || !source.entityId ? null : source.entityId,
    cash: source.remainder,
    oldestFirst: source.entityId ? oldestFirstByEntity.get(source.entityId) ?? true : true,
    floor: invoiceFloor(subledger === 'ap' ? 'supplier' : 'customer'),
  }));
  const simulated = new Map(
    simulateSequentialApplications(simLines, openByEntity).map((l) => [l.index, l]),
  );

  return assembleBackfillPlan(true, subledger, sources.map((source, index) => ({
    source,
    lines: (simulated.get(index)?.applications ?? []).map((a) => ({
      document_id: a.documentId,
      document_number: a.documentNumber,
      invoice_date: documentDates.get(a.documentId) ?? null,
      amount: a.amount,
    })),
  })));
}
