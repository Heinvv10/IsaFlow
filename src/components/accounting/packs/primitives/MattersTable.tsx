/**
 * Spec §4.A page 11 — the matters requiring board attention, as a TABLE.
 *
 * Five fixed columns: Issue, Quantum, Owner, Movement, Decision required.
 * `PackTable`/`ComparativeTable` cannot carry this — their column keys are
 * financial (actual/prior/change/…) and four of these five columns are
 * prose, so a matter has nothing to put in them. That is why `matters` is
 * its own block kind rather than another `table`.
 *
 * `quantum` is a raw rand amount, not a `PackFigure`: it is the size of an
 * exposure assembled by `buildMatters` from a report, not a ledger balance
 * with a `source` to trace. It is still scaled with the document, for the
 * same reason every other money column is — a quantum in rands beside a
 * statement in thousands is the 1000x misread, one page later.
 */
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';

export interface MattersTableProps {
  matters: PackMatter[];
  /** The document's `numberConvention.scale` — see `formatFigureText`. */
  scale: MoneyScale;
}

/** Spec §5.5: zebra banding only past 12 rows. Same threshold as
 *  `ComparativeTable`; a board pack that bands one table at 10 rows and
 *  another at 13 reads as two documents. */
const ZEBRA_ROW_THRESHOLD = 12;

export function MattersTable({ matters, scale }: MattersTableProps) {
  const isLong = matters.length > ZEBRA_ROW_THRESHOLD;

  return (
    <table className={isLong ? 'pack-table pack-matters is-long' : 'pack-table pack-matters'}>
      <thead>
        <tr>
          <th>Issue</th>
          <th>Quantum</th>
          <th>Owner</th>
          <th>Movement</th>
          <th>Decision required</th>
        </tr>
      </thead>
      <tbody>
        {matters.map((matter, index) => (
          <tr key={`${matter.issue}-${index}`} className="pack-matters-row">
            <td>{matter.issue}</td>
            {/* An en dash, not a zero: a filing that is overdue has no rand
             *  amount, and "R0" would say the exposure was measured and
             *  found to be nothing. */}
            <td>{matter.quantum === null ? '–' : formatMoney(matter.quantum, { scale })}</td>
            <td>{matter.owner}</td>
            <td>{matter.movement}</td>
            <td>{matter.decisionRequired}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
