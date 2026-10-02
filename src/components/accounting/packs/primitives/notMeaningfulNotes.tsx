/**
 * A not-meaningful figure, in a table: a mark in the cell, and the reason in
 * full once beneath the table.
 *
 * `PackFigure.unavailable` carries the REASON a figure is not meaningful
 * (R-P44/R-P45), and printing it in the cell is right in a KPI tile, which
 * has a paragraph of room. In a numeric column it is a three-line paragraph
 * where a number belongs — and a company with no positive comparative base
 * gives every row the SAME sentence, so the income statement printed it seven
 * times and the scorecard's prior column printed it on every ratio. Four
 * pages of the first rendered pack spilled onto a second sheet on that alone.
 *
 * NOTHING IS DROPPED AND NOTHING IS SUMMARISED. The sentence is printed, in
 * full, once per distinct reason, keyed by the mark its cells carry. What
 * changes is that it is said once instead of seven times.
 *
 * Shared by `ComparativeTable` and `ScorecardTable` rather than written
 * twice: two tables on facing pages marking the same condition differently is
 * how a pack starts reading as two documents.
 */
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

/**
 * The mark for the nth note under a table: a, b, … z, aa, ab.
 *
 * Letters, deliberately: `PackFootnote` numbering belongs to the PAGE, and a
 * second numeric series under a table would read as a continuation of it.
 *
 * Unbounded, also deliberately. A fixed list needs a fallback for when it
 * runs out, and the only fallback available is printing the sentence in the
 * cell — which is what this mechanism exists to stop, and which under
 * `white-space: nowrap` runs off the edge of the paper rather than wrapping.
 * A silent clipping path reachable only on an unusual company is exactly the
 * defect class this pack keeps producing.
 */
export function noteMark(index: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const first = Math.floor(index / letters.length);
  const second = letters[index % letters.length]!;
  return first === 0 ? second : `${letters[first - 1]!}${second}`;
}

/** The distinct reasons among these figures, in the order first met. Absent
 *  entries are skipped: a column a row does not carry is not a reason —
 *  `PackTable` spells that `undefined` and `PackScorecardRow` spells it
 *  `null`, so both are accepted rather than making each caller filter. */
export function collectReasons(figures: Array<PackFigure | null | undefined>): string[] {
  const reasons: string[] = [];
  for (const figure of figures) {
    if (figure === undefined || figure === null || figure.value !== null) continue;
    const reason = figure.unavailable;
    if (reason !== undefined && reason !== null && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

/**
 * What a not-meaningful cell prints: `n/m` and the mark pointing at its note.
 *
 * The mark is omitted rather than falling back to the sentence when the
 * reason is not in `reasons` — `PackFigureProvenance.figure()` refuses to
 * construct a null figure without a reason, so that cannot happen for a
 * figure the pack built, and printing prose in a `nowrap` numeric cell would
 * run it off the paper if it ever did.
 */
export function NotMeaningfulCell({ figure, reasons }: { figure: PackFigure; reasons: string[] }) {
  const index = figure.unavailable ? reasons.indexOf(figure.unavailable) : -1;
  return (
    <>
      n/m{index >= 0 && <sup className="pack-table-note-mark">{noteMark(index)}</sup>}
    </>
  );
}

/** The note list itself, printed directly under the table it belongs to. */
export function NotMeaningfulNotes({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <dl className="pack-table-notes">
      {reasons.map((reason, index) => (
        <div key={reason}>
          <dt>{noteMark(index)}</dt>
          <dd>
            <abbr title="not meaningful">n/m</abbr> — {reason}
          </dd>
        </div>
      ))}
    </dl>
  );
}
