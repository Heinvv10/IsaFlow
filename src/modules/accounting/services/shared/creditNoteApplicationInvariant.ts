/**
 * The invariant every credit-note application write must leave behind, checked
 * in the SAME transaction, after the note's `applied_amount` is written:
 *
 *   1. what the documents' `amount_paid` actually moved (measured by the row
 *      writers, stored figure after less before) equals what the allocation
 *      rows moved, to the cent;
 *   2. the note's `applied_amount` now equals its allocation rows, to the cent.
 *
 * WHICH CHECK CATCHES WHAT. (1) can only fire when something REWRITES the
 * figure the writer put on the document — a trigger, a rounding rule, a sub-cent
 * amount Postgres rounds differently from the row — because each writer moves
 * the row and `amount_paid` by the same line. (2) is the drift detector: a
 * caller that records an `applied_amount` its rows do not add up to.
 *
 * CN-388 (Velocity, Nov 2026) ended with R490.44 recorded on the note and
 * R490.45 credited to its bill: R0.01 counted as used on the document with no
 * application behind it on the note. Comparing MOVEMENTS (1) is what lets a
 * correction through: taking back a note already a cent apart moves the rows
 * and the documents by what the rows held, and (2) then holds because the
 * decreasing paths re-derive `applied_amount` from the rows that remain. A
 * failure is thrown, never returned: the documents have already moved, so the
 * caller's transaction must unwind.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
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
  /** Σ amounts written to allocation rows less Σ amounts taken off them (negative for an undo). */
  rowsMoved: number;
  /** Σ what the row writers measured `amount_paid` move by. */
  paidMoved: number;
  /** The `applied_amount` the caller recorded. */
  appliedAfter: number;
}

export async function assertApplicationRecorded(
  companyId: string,
  creditNoteId: string,
  label: string,
  m: ApplicationMovement,
): Promise<void> {
  const rowsMoved = round2(m.rowsMoved);
  const paidMoved = round2(m.paidMoved);
  if (Math.abs(rowsMoved - paidMoved) >= HALF_CENT) {
    throw new CreditNoteApplicationDriftError(
      `Credit note ${label}: the documents' balances moved ${formatMoney(paidMoved)} but its applications moved `
      + `${formatMoney(rowsMoved)}. Nothing was recorded.`,
    );
  }
  const [r] = (await sql`
    SELECT COALESCE(SUM(amount_allocated), 0) AS allocated FROM credit_note_allocations
    WHERE credit_note_id = ${creditNoteId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const allocated = round2(Number(r?.allocated ?? 0));
  if (Math.abs(allocated - round2(m.appliedAfter)) >= HALF_CENT) {
    throw new CreditNoteApplicationDriftError(
      `Credit note ${label}: its applications total ${formatMoney(allocated)} but its applied amount would be `
      + `${formatMoney(round2(m.appliedAfter))}. Nothing was recorded.`,
    );
  }
}
