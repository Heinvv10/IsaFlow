/**
 * The statement half of the figure-integrity gate (spec §7.2): does each
 * statement foot, and does each column hold what its heading claims?
 *
 * Split from `packFigureIntegrity.ts` for the 300-line cap. The orchestrator
 * there owns the checks that walk FIGURES — resolution through the provenance
 * map, and the percentage recompute; this file owns the ones that walk the
 * STATEMENTS those figures make up.
 *
 * Every identity below is checked against the provenance map rather than
 * against table rows, and that is deliberate: a source name
 * (`packFigureSet.current.totalAssets`) is unambiguous, where a row label is a
 * string a page may re-word. It also keeps the check away from the trap in the
 * other formulation — summing a table's line rows into its subtotal row is
 * WRONG here, because a statement prints cost of sales as a positive number it
 * then subtracts. A gate built that way reports the income statement as broken
 * on every correct pack, which is the fastest way to teach a team to bypass it.
 */

import { formatMoney } from '@/lib/format/money';
import type { PackPagesDocument, PackTable, PackTableColumnKey } from '../pages/packPageModel';
import { formatPackPeriod } from '../pages/packPeriodLabel';
// The CONSTANT, not the string it holds. Two reasons: `packOperatingProfitReading`
// guards the one-reading rule by scanning these files for reads of the raw
// optional field, and it matches on text, so spelling the source out here
// would trip a guard this file does not break; and an identity keyed to a
// COPY of a source name silently stops checking anything the day that source
// is renamed.
import { OPERATING_PROFIT_SOURCE } from './packMetricReads';
import { MONEY_TOLERANCE } from './packWaterfallIntegrity';

/** The one value a source was issued with, or null when it was never issued
 *  or is not meaningful. `assertConsistent` has already refused a source with
 *  two values, so the first reading is THE reading. */
export function valueOf(doc: PackPagesDocument, source: string): number | null {
  const issued = doc.provenance.all().get(source);
  return issued?.[0]?.value ?? null;
}

interface Identity {
  /** What fails, in the sentence a reader sees. */
  statement: string;
  target: string;
  /**
   * What the target is CALLED on the page, for that same reader.
   *
   * The refusal reaches a director's screen — the Brightsphere pack was
   * refused, correctly, and the message they were given read
   * "'packFigureSet.current.totalAssets' states 3191495.16 but +
   * packFigureSet.current.totalLiabilities 5368200.63 …". The first sentence
   * was fine and the rest was a stack trace in prose, with nothing in it a
   * reader could act on. The source paths stay in the code, where the person
   * who needs them is; the sentence names the figures the way the statement
   * does and states the gap.
   */
  targetLabel: string;
  terms: ReadonlyArray<{ source: string; label: string; sign: 1 | -1 }>;
}

const IDENTITIES: readonly Identity[] = [
  {
    statement: 'The balance sheet does not foot: assets do not equal liabilities plus equity',
    target: 'packFigureSet.current.totalAssets',
    targetLabel: 'total assets',
    terms: [
      { source: 'packFigureSet.current.totalLiabilities', label: 'total liabilities', sign: 1 },
      { source: 'packFigureSet.current.totalEquity', label: 'total equity', sign: 1 },
    ],
  },
  {
    statement: 'Non-current assets do not equal total assets less current assets',
    target: 'packStatementTables.nonCurrentAssets',
    targetLabel: 'non-current assets',
    terms: [
      { source: 'packFigureSet.current.totalAssets', label: 'total assets', sign: 1 },
      { source: 'packFigureSet.current.currentAssets', label: 'current assets', sign: -1 },
    ],
  },
  {
    statement: 'Non-current liabilities do not equal total liabilities less current liabilities',
    target: 'packStatementTables.nonCurrentLiabilities',
    targetLabel: 'non-current liabilities',
    terms: [
      { source: 'packFigureSet.current.totalLiabilities', label: 'total liabilities', sign: 1 },
      { source: 'packFigureSet.current.currentLiabilities', label: 'current liabilities', sign: -1 },
    ],
  },
  {
    // I-2. EBITDA is a DERIVED subtotal here in the strictest sense: the pack
    // hands `calculateExtendedRatios` no depreciation or amortisation field,
    // so `ebitda = ebit + dep + amort` reduces to the operating line, rounded
    // to two decimals. That identity is worth pinning precisely because it is
    // invisible on the page — a reader sees "EBITDA" and reads a different
    // measure from the one above it. If a depreciation figure is ever added
    // to `toFinancialData`, this check FAILS, which is the correct alarm:
    // EBITDA would then genuinely differ from EBIT and this identity must
    // gain the term rather than be deleted.
    statement:
      'EBITDA does not equal the operating line. The pack captures no depreciation or amortisation, so the two cannot differ — if one has been added, this identity needs the extra term',
    target: 'calculateExtendedRatios.ebitda',
    targetLabel: 'EBITDA',
    terms: [{ source: OPERATING_PROFIT_SOURCE, label: 'the operating line', sign: 1 }],
  },
  {
    statement: 'Gross profit does not equal revenue less cost of sales',
    target: 'packStatementTables.grossProfit',
    targetLabel: 'gross profit',
    terms: [
      { source: 'packFigureSet.current.revenue', label: 'revenue', sign: 1 },
      { source: 'packFigureSet.current.costOfSales', label: 'cost of sales', sign: -1 },
    ],
  },
];

/**
 * The three balance-sheet totals every board pack must have recorded.
 *
 * Without this, a pack that simply never issued them would SKIP the footing
 * check and pass — the quietest false green there is, and the one a fixture
 * built for some other purpose walks into first.
 */
const REQUIRED_SOURCES = [
  'packFigureSet.current.totalAssets',
  'packFigureSet.current.totalLiabilities',
  'packFigureSet.current.totalEquity',
] as const;

/** Check 3 — the statements foot on the figures the pack itself recorded. */
export function checkStatements(doc: PackPagesDocument): string[] {
  const failures: string[] = [];
  for (const source of REQUIRED_SOURCES) {
    if (!doc.provenance.all().has(source)) {
      failures.push(
        `The pack never recorded '${source}', so the balance sheet cannot be ` +
          `checked. An unverifiable statement is refused, not assumed correct.`,
      );
    }
  }

  for (const identity of IDENTITIES) {
    const target = valueOf(doc, identity.target);
    const terms = identity.terms.map((term) => ({ ...term, value: valueOf(doc, term.source) }));
    // A figure this pack never issued, or issued as not meaningful, leaves
    // nothing to reconcile — that is R-P44's honest absence, not a mismatch.
    if (target === null || terms.some((term) => term.value === null)) continue;

    const expected = terms.reduce((sum, term) => sum + term.sign * (term.value as number), 0);
    if (Math.abs(target - expected) > MONEY_TOLERANCE) {
      const money = (n: number) => formatMoney(n, { cents: true, symbol: true });
      const detail = terms
        .map((term, index) => {
          const word = index === 0 ? '' : term.sign === 1 ? 'plus ' : 'less ';
          return `${word}${term.label} of ${money(term.value as number)}`;
        })
        .join(' ');
      failures.push(
        `${identity.statement}. The pack states ${identity.targetLabel} as ${money(target)}; ` +
          `${detail} adds up to ${money(expected)}, a difference of ` +
          `${money(Math.abs(target - expected))}.`,
      );
    }
  }
  return failures;
}

/**
 * Check 6 — the comparative column holds comparative readings.
 *
 * The model carries no per-column DATE label, so this cannot compare a header
 * against a period string; what it can prove is the half that matters, which
 * is where the cells came from. Every prior cell is issued as `<source>.prior`
 * by `packStatementTables`, so a prior column filled from current-period
 * figures — the defect that puts this period's numbers under last period's
 * heading — has no `.prior` source to show for itself.
 */
const PRIOR_SUFFIX = '.prior';

export function checkColumns(table: PackTable, where: string): string[] {
  const failures: string[] = [];
  const declared = new Set<PackTableColumnKey>(table.columns);
  const carried = new Set<string>();

  for (const row of table.rows) {
    for (const [column, figure] of Object.entries(row.figures)) {
      if (!figure) continue;
      carried.add(column);
      if (!declared.has(column as PackTableColumnKey)) {
        failures.push(
          `${where} row '${row.label}' carries a '${column}' figure the table ` +
            `never declared as a column, so it prints under no heading.`,
        );
      }
      if (column === 'prior' && !figure.source.endsWith(PRIOR_SUFFIX)) {
        failures.push(
          `${where} row '${row.label}' fills the comparative column from ` +
            `'${figure.source}', which is not a prior-period reading. The ` +
            `column would be headed as a comparative and hold this period.`,
        );
      }
      if (column === 'actual' && figure.source.endsWith(PRIOR_SUFFIX)) {
        failures.push(
          `${where} row '${row.label}' fills the actual column from the ` +
            `prior-period reading '${figure.source}'.`,
        );
      }
    }
  }

  for (const column of table.columns) {
    if (!carried.has(column)) {
      failures.push(
        `${where} declares a '${column}' column that no row carries, so the ` +
          `pack prints an empty heading rather than omitting the column.`,
      );
    }
  }
  return failures;
}


/**
 * The cash flow reconciles OPENING to CLOSING cash — the endpoints, not just
 * the walk.
 *
 * `checkWaterfall` proves the cash bridge's bars add up among themselves. It
 * cannot prove the bridge is bridging the right two balances: a chart drawn
 * from some other opening figure adds up perfectly and still contradicts the
 * cash table one block above it. These two comparisons are what tie the chart
 * to the statement, and they are the reason the check lives here rather than
 * with the bar walk.
 *
 * The bridge is absent for a first-period company (no prior close to open
 * from), and page 8 says so in words instead. Absent is not checked; present
 * and wrong is.
 */
const CASH_BRIDGE_ID = 'cash-bridge';

export function checkCashBridgeEndpoints(doc: PackPagesDocument): string[] {
  const bars = doc.pages
    .flatMap((page) => page.blocks)
    .flatMap((block) => (block.kind === 'chart' ? [block.chart] : []))
    .find((chart) => chart.id === CASH_BRIDGE_ID)?.waterfallBars;
  if (bars === undefined || bars.length < 2) return [];

  const opening = valueOf(doc, 'packFigureSet.prior.cash');
  const closing = valueOf(doc, 'packFigureSet.current.cash');
  const failures: string[] = [];
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;

  if (opening !== null && Math.abs(first.end - opening) > MONEY_TOLERANCE) {
    failures.push(
      `The cash bridge opens at ${first.end.toFixed(2)} but the cash ` +
        `statement's opening balance is ${opening.toFixed(2)}. The chart and ` +
        `the table on page 8 do not describe the same period.`,
    );
  }
  if (closing !== null && Math.abs(last.end - closing) > MONEY_TOLERANCE) {
    failures.push(
      `The cash bridge closes at ${last.end.toFixed(2)} but the cash ` +
        `statement's closing balance is ${closing.toFixed(2)}. The cash flow ` +
        `does not reconcile opening cash to closing cash.`,
    );
  }
  return failures;
}

/**
 * The comparative is the period the pack CLAIMS it is — R-P55.
 *
 * `checkColumns` above proves each prior cell came from a prior-period
 * reading. That is the provenance half, and it is satisfied by a document
 * whose data is right and whose HEADING is wrong: a director reads
 * "1 September 2025 to 28 February 2026" and takes the column as read. Right
 * data under a wrong label is a lie a provenance check cannot see, which is
 * why the label is re-derived here from the window the figures were read over
 * and compared.
 *
 * The other two failures are the pair that must not come apart: a statement
 * showing a comparative column while the pack states no comparative period,
 * and a pack stating one that no statement compares against. Page 12 prints
 * that period in the basis of preparation, so the second is not academic —
 * it is a period claimed to a reader that nothing in the pack used.
 */
export function checkComparativePeriod(doc: PackPagesDocument): string[] {
  const failures: string[] = [];
  const showsComparative = doc.pages.some((page) =>
    page.blocks.some((block) => block.kind === 'table' && block.table.columns.includes('prior')),
  );
  const comparative = doc.comparativePeriod;

  if (comparative === null) {
    if (showsComparative) {
      failures.push(
        `A statement shows a comparative column, but the pack states no ` +
          `comparative period. The column would be headed with nothing a ` +
          `reader could check it against.`,
      );
    }
    return failures;
  }

  if (!showsComparative) {
    failures.push(
      `The pack states a comparative period of ${comparative.label}, which ` +
        `page 12 prints, but no statement carries a comparative column. It ` +
        `claims a comparison the pack does not make.`,
    );
  }

  const expected = formatPackPeriod(comparative.start, comparative.end);
  if (comparative.label !== expected) {
    failures.push(
      `The comparative column is headed '${comparative.label}' but the ` +
        `comparative figures were read over ${comparative.start} to ` +
        `${comparative.end}, which is ${expected}. The pack's data and its ` +
        `heading describe different periods.`,
    );
  }
  return failures;
}
