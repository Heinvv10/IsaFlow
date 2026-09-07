/**
 * Spec §4.A page 11 — the matters requiring board attention, as a TABLE.
 *
 * Five fixed columns: Issue, Quantum, Owner, Movement, Decision required.
 * `PackTable`/`ComparativeTable` cannot carry this — their column keys are
 * financial (actual/prior/change/…) and four of these five columns are
 * prose, so a matter has nothing to put in them. That is why `matters` is
 * its own block kind rather than another `table`.
 *
 * A COLUMN WHOSE EVERY ROW SAYS THE SAME THING IS PRINTED ONCE. `buildMatters`
 * gives every unusual journal the same movement ("Not tracked — no prior
 * board pack is stored…") and the same decision, and on the fifteen matters
 * the real company produced that was two paragraphs repeated fifteen times —
 * enough to push the page across three sheets. The sentence still reaches the
 * reader, in full, as a note under the table saying it applies to every
 * matter. It collapses only on an EXACT match across every row, so a column
 * that actually differs is never flattened into a claim about all of them.
 *
 * `quantum` IS a `PackFigure` (I-4). It was a raw rand amount on the argument
 * that an exposure assembled from four reports is not a ledger balance with a
 * source to trace — but it is a number printed in a money column of a board
 * pack, and §7.2's first bullet admits no exception, so it now resolves
 * through the provenance map like every other figure here. It is scaled with
 * the document for the same reason every other money column is: a quantum in
 * rands beside a statement in thousands is the 1000x misread, one page later.
 */
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import { mattersColumnPercents } from '@/modules/accounting/services/packs/pages/packMattersColumns';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackMatterFigure } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface MattersTableProps {
  matters: PackMatterFigure[];
  /**
   * The matters that did not fit on the sheet, or null when they all did.
   *
   * A table that prints ten of twenty-eight rows and says nothing has hidden
   * eighteen decisions from the people accountable for them. The note below
   * is the only thing standing between the sheet-count fix and that.
   */
  omitted: { count: number; quantum: PackFigure } | null;
  /** The document's `numberConvention.scale` — see `formatFigureText`. */
  scale: MoneyScale;
}

/** Spec §5.5: zebra banding only past 12 rows. Same threshold as
 *  `ComparativeTable`; a board pack that bands one table at 10 rows and
 *  another at 13 reads as two documents. */
const ZEBRA_ROW_THRESHOLD = 12;

/** The three prose columns that can repeat, in print order. */
const PROSE_COLUMNS = [
  { key: 'owner', label: 'Owner' },
  { key: 'movement', label: 'Movement' },
  { key: 'decisionRequired', label: 'Decision required' },
] as const;

type ProseColumn = (typeof PROSE_COLUMNS)[number]['key'];

/** The columns every matter answers identically — printed once, below. */
function uniformColumns(matters: PackMatterFigure[]): ProseColumn[] {
  if (matters.length < 2) return [];
  return PROSE_COLUMNS
    .filter(({ key }) => matters.every((m) => m[key] === matters[0]![key]))
    .map(({ key }) => key);
}

/**
 * The uniform value as a finished sentence, so the clause after it starts one.
 *
 * It was joined with an em dash: "Not tracked — no prior board pack is stored
 * to compare against. — the same for every matter listed above." A full stop
 * and a dash, because the joiner assumed a fragment and every value the pack
 * actually produces is a sentence.
 */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function MattersTable({ matters, omitted, scale }: MattersTableProps) {
  const isLong = matters.length > ZEBRA_ROW_THRESHOLD;
  const uniform = uniformColumns(matters);
  const columns = PROSE_COLUMNS.filter((c) => !uniform.includes(c.key));

  return (
    <>
      <table className={isLong ? 'pack-table pack-matters is-long' : 'pack-table pack-matters'}>
        {/* THE COLUMNS ARE STATED, NOT NEGOTIATED WITH THE CONTENT.
          * `table-layout: auto` sizes a column from what is in it, which
          * means the height model could not know a cell's measure without
          * laying the table out — and it did not: it charged the live demo
          * company's page 78mm for a table Chromium set in 95, so five of
          * twenty-eight matters printed under half a sheet of white space.
          * The widths come from `packMattersColumns`, the same file the
          * ruler wraps its cells to. */}
        <colgroup>
          {mattersColumnPercents(columns.length).map((width, i) => (
            <col key={width + String(i)} style={{ width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th>Issue</th>
            {/* The scale, in the header of the one column that carries money.
              * `ComparativeTable` states it above its own figure columns and
              * this table stated it nowhere, so a quantum of `245` sat on a
              * page with no unit anywhere near it — and the note below the
              * table says what the matters not printed "come to", at the same
              * scale. Spec §5.5: a table must read alone. */}
            <th>Quantum ({scale})</th>
            {columns.map((c) => <th key={c.key}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {matters.map((matter, index) => (
            <tr key={`${matter.issue}-${index}`} className="pack-matters-row">
              <td>{matter.issue}</td>
              {/* `n/m`, not a dash and not a zero: a filing that is overdue
                * has no rand amount. "R0" would say the exposure was measured
                * and found to be nothing, and the dash says exactly that
                * everywhere else in the pack — `formatMoney` prints a
                * measured zero as an en dash and page 12 now defines it that
                * way. A quantum that does not exist is the pack's other
                * convention, which page 12 also defines. */}
              <td>{matter.quantum.value === null ? 'n/m' : formatMoney(matter.quantum.value, { scale })}</td>
              {columns.map((c) => <td key={c.key}>{matter[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {/* WHY they are not printed, and it is not "no room on this page".
        * The note used to say "not printed on this page", under six rows and
        * above 45% of blank white — a page contradicting its own excuse. The
        * table is held to the paper this page has left after its heading,
        * commentary and disclosure, so that a board pack is twelve sheets for
        * every company however busy its ledger; that is a different reason
        * from the sheet being full, and it is the true one.
        *
        * The ordering it states is the ordering `selectPrintedMatters` now
        * prints: two AFS filings 739 and 10 days overdue used to rank fifth
        * and sixth under a note saying they would come first. */}
      {omitted !== null && (
        <p className="pack-matters-omitted">
          {omitted.count} further {omitted.count === 1 ? 'matter is' : 'matters are'} not printed.
          This table is held to what the page has room for, so that a board pack is the same twelve
          sheets for every company: matters with no single rand amount are listed first, then the
          largest by exposure.{' '}
          {omitted.quantum.value === null
            ? omitted.quantum.unavailable
            : `They come to ${formatMoney(omitted.quantum.value, { scale })} ${scale} in total.`}
        </p>
      )}
      {uniform.length > 0 && (
        <dl className="pack-table-notes">
          {PROSE_COLUMNS.filter((c) => uniform.includes(c.key)).map((c) => (
            <div key={c.key}>
              <dt>{c.label}</dt>
              <dd>{asSentence(matters[0]![c.key])} The same for every matter listed above.</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}
