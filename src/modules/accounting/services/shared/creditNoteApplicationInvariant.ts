/**
 * The invariant every credit-note application write must leave behind, checked
 * in the SAME transaction, after the note's `applied_amount` is written:
 *
 *   what the documents' `amount_paid` actually moved (measured by the row
 *   writers, stored figure after less before) equals what the note's
 *   `applied_amount` moved, to the cent.
 *
 * Rows and column need no second check here: each writer moves the row and the
 * document by the same line, and `assertAllocationsMatchApplied` (exact) refuses
 * a note whose rows and column already disagree before anything is written.
 *
 * CN-388 (Velocity, Nov 2026) ended with R490.44 recorded on the note and
 * R490.45 credited to its bill: R0.01 counted as used on the document with no
 * application behind it on the note. Each writer moves the document and the
 * row by the same line, but the NOTE's figure is set by its caller from its own
 * arithmetic — so the place a cent can slip is between the two, and that is
 * what this compares. A failure is thrown, never returned: the documents have
 * already moved, so the caller's transaction must unwind.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { round2 } from './autoAllocateStrategy';

export class CreditNoteApplicationDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditNoteApplicationDriftError';
  }
}

const HALF_CENT = 0.005;

export interface ApplicationMovement {
  /** `credit_notes.applied_amount` before this write and the figure the caller recorded. */
  appliedBefore: number;
  appliedAfter: number;
  /** Σ what the row writers measured `amount_paid` move by (negative for an undo). */
  paidMoved: number;
}

export function assertApplicationRecorded(label: string, m: ApplicationMovement): void {
  const noteMoved = round2(m.appliedAfter - m.appliedBefore);
  const paidMoved = round2(m.paidMoved);
  if (Math.abs(noteMoved - paidMoved) >= HALF_CENT) {
    throw new CreditNoteApplicationDriftError(
      `Credit note ${label}: the documents' balances moved ${formatMoney(paidMoved)} but the note's applied amount `
      + `moved ${formatMoney(noteMoved)}. Nothing was recorded.`,
    );
  }
}
