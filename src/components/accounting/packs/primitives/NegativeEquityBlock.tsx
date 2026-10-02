/**
 * Spec §3.5 / rubric criterion 10: where total equity is negative, the pack
 * must state the amount AND the consequence — a negative number printed with
 * no comment fails the gate. `equity` is a raw figure rather than a
 * `PackFigure`: this block is the disclosure prose itself, not a table cell
 * with a `source` to trace.
 *
 * Renders nothing when equity is not negative — this block exists only to
 * carry the negative-equity disclosure, so a non-negative figure has nothing
 * for it to say.
 */
import { negativeEquitySentence } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type { MoneyScale } from '@/lib/format/money';

export interface NegativeEquityBlockProps {
  equity: number;
  /** The document's `numberConvention.scale` — see `formatFigureText`. This
   *  block prints a rand amount, so it takes the scale the rest of the page
   *  prints at rather than assuming rands. */
  scale: MoneyScale;
}

export function NegativeEquityBlock({ equity, scale }: NegativeEquityBlockProps) {
  if (equity >= 0) return null;

  return (
    <div className="pack-disclosure pack-disclosure-negative-equity">
      <h3 className="pack-disclosure-heading">Negative equity</h3>
      <p className="pack-disclosure-body">{negativeEquitySentence(equity, scale)}</p>
    </div>
  );
}
