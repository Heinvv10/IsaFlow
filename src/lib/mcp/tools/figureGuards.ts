/**
 * What actually checked each figure a report publishes OUTSIDE its identity.
 *
 * WHY THIS IS A FUNCTION AND NOT AN OBJECT LITERAL. `figure_guards` shipped as
 * five hardcoded strings emitted on every call — a DECLARATION that a guard
 * existed, not a MEASUREMENT that one ran. That is the same shape as a
 * `universeTotal` synthesised from the numbers it is meant to check, which this
 * module refuses to ship: a claim that cannot fail, reading as verification. The
 * defect class had reproduced inside the remedy built for it, which is the most
 * instructive thing that happened on this branch.
 *
 * So a label here is produced BY running a comparison. `enumerated` means one
 * ran and agreed; `unguarded` means the figure's rows were not emitted and
 * nothing checked it, which is a legitimate answer the contract explicitly
 * allows — "carry a guard that can fail, OR say it is unguarded". A figure
 * labelled `enumerated` with no enumeration behind it is worse than one
 * labelled `unguarded`, because the first is a lie and the second is a warning.
 *
 * WHY AT THE WIRE BOUNDARY. The check compares a total against THE ROWS THE
 * RESPONSE ACTUALLY CARRIES. Run in the service instead, over the array the
 * total was reduced from, it cannot fail by construction — and it would miss
 * the one failure most likely to appear next, a cap applied while mapping to
 * the response, which is downstream of the service entirely.
 *
 * WHAT IT STILL CANNOT DO. It cannot test the QUERY that found the rows. A row
 * the predicate never matched is invisible to this and to every other number in
 * the report. That limit belongs in the tool description, not only here.
 */

/** Cents. Below this two money figures are the same number. */
const TOLERANCE = 0.005;

export type FigureGuard = 'identity' | 'enumerated' | 'unguarded';

export interface FigureCheck {
  /** The response field being checked, as the caller sees it. */
  figure: string;
  total: number;
  /**
   * The values carried by the rows the RESPONSE emits for this figure.
   *
   * `null` when the response carries no rows for it — then nothing can be
   * checked and the figure is reported `unguarded` rather than assumed sound.
   */
  rows: number[] | null;
}

export interface FigureGuardResult {
  guards: Record<string, FigureGuard>;
  /** Absent when every executed check agreed. Never thrown — see below. */
  fault?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Runs every check and reports what it found.
 *
 * NEVER THROWS. A read tool has no savepoint, so a throw after the query has run
 * aborts the whole request transaction and the registry's refund and audit
 * writes fail with 25P02. "This report cannot account for a figure it published"
 * is also an assurance finding that belongs in front of the reader rather than
 * converted into an error that tells them nothing — the same reasoning
 * `buildEnvelope` applies to `completenessFault`.
 */
export function measureFigureGuards(checks: readonly FigureCheck[]): FigureGuardResult {
  const guards: Record<string, FigureGuard> = {};
  const faults: string[] = [];

  for (const check of checks) {
    if (check.rows === null) {
      guards[check.figure] = 'unguarded';
      continue;
    }
    const summed = round2(check.rows.reduce((t, n) => t + n, 0));
    const total = round2(check.total);
    guards[check.figure] = 'enumerated';
    if (Math.abs(summed - total) >= TOLERANCE) {
      faults.push(
        `${check.figure} reports ${total.toFixed(2)} while the ${check.rows.length} row(s) `
        + `beside it sum to ${summed.toFixed(2)}`,
      );
    }
  }

  return { guards, ...(faults.length === 0 ? {} : { fault: faults.join('; ') }) };
}
