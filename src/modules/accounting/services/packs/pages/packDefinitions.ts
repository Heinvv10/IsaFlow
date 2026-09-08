/**
 * EVERY MEASURE THE PACK PRINTS THAT IS NOT A LINE OF A STATEMENT, DEFINED —
 * and the one that is not IFRS at all, reconciled.
 *
 * Page 12 defined four terms. The pack printed EBITDA, working capital,
 * debtor days, creditor days, cash ratio, debt-to-equity, interest cover,
 * operating margin, operating cash flow and the cash conversion cycle, none
 * of them defined anywhere. EBITDA was the one that mattered: it printed as
 * `(1 546)`, identical to operating profit to the rand, with nothing on the
 * page to tell a director whether depreciation was nil or the measure was
 * simply unimplemented. It was the second.
 *
 * SO EBITDA IS NOW A MEASURE RATHER THAN A LABEL. `ReportPackFigures` carries
 * the classifier's own depreciation-and-amortisation charge,
 * `calculateExtendedRatios` adds it back as it always claimed to, and the
 * definition below prints the bridge line by line — operating profit, the
 * add-back, EBITDA — as FIGURES, each resolving through the provenance map
 * against the same sources the group-results table prints. Prose cannot carry
 * a reconciliation: a reader has to be able to add it up.
 *
 * The add-back is drawn from the ledger, so where a company genuinely charges
 * no depreciation the bridge prints a nil add-back and the two lines are
 * equal — which is now a FACT the page states rather than a coincidence a
 * reader has to guess at.
 *
 * The rest are ratios and formulas rather than adjusted measures, so none
 * carries a `reconciliation`: there is nothing to bridge from an IFRS figure
 * to an adjusted one. What they need is a definition, because "debtor days"
 * is not a term with one meaning — receivables over revenue times 365 and
 * receivables over revenue times the days in the month are both called that,
 * and this pack prints both, on two different pages.
 *
 * WHICH IS WHY THE DAY COUNT IS STATED. The definitions said "times the days
 * in the period" while `calculateExtendedRatios` multiplied by 365, so the
 * one measure a director is most likely to query was the one the pack could
 * not explain: creditor days of 1 035 on cost of sales of 805 implies trade
 * payables of 3 401 under the printed definition, against total liabilities
 * of 2 281. Impossible — and ÷ 365 gives 2 283, which ties. The computation
 * is the annualised convention every ratio in this repo uses (AFS KPIs, the
 * scorecard, the ratio trends); it is the prose that was wrong, and the prose
 * is what moved.
 */
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { OPERATING_PROFIT_SOURCE, operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { formatMoney } from '@/lib/format/money';
import { PACK_SCALE } from './packBasis';
import { toFinancialData } from './packScorecard';
import type { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackDefinition } from './packPageModel';

/** The source page 5's EBITDA row already records. Restated here so the
 *  reconciliation's closing line and the table's cell are ONE figure — two
 *  sources for one number is what `assertConsistent` exists to refuse. */
export const EBITDA_SOURCE = 'calculateExtendedRatios.ebitda';
export const DEPRECIATION_SOURCE = 'packFigureSet.current.depreciation';

/** A raw rand amount as the page PRINTS it — the unit a reader adds. Half
 *  away from zero, which is what `Intl.NumberFormat` does inside
 *  `formatMoney`, so this cannot disagree with the cell beside it. */
function atPackScale(rands: number): number {
  return Math.sign(rands) * Math.round(Math.abs(rands) / 1_000);
}

/**
 * THE ONE TABLE IN A BOARD PACK WHOSE JOB IS TO ADD, SAYING SO WHEN IT DOES
 * NOT ADD AS PRINTED.
 *
 * The three lines are unrounded rands and each is rounded to the nearest
 * R'000 on its own, so the sum of the roundings and the rounding of the sum
 * differ by a unit whenever the fractions carry it: the live demo pack printed
 * operating profit (1 545), an add-back of 77 and EBITDA of (1 467), where the
 * printed operands give (1 468). Nothing is wrong with any of the three
 * figures, and page 12 already carries a general rounding note — but a
 * director invited to foot a non-IFRS bridge should not have to reach for a
 * caveat in another column to make it work. This states it on the line, in the
 * unrounded figures, so the arithmetic is visibly right rather than merely
 * derivable.
 *
 * Null where the printed lines add, which is most packs — a note explaining a
 * discrepancy a reader cannot find is worse than no note.
 */
export function bridgeRoundingNote(operating: number, addBack: number, ebitda: number): string | undefined {
  if (atPackScale(operating) + atPackScale(addBack) === atPackScale(ebitda)) return undefined;
  const exact = (n: number) => formatMoney(n, { cents: true });
  // IN RANDS, AND IT SAYS SO. Every other figure on this page is in R'000,
  // and three unrounded amounts printed beside them with no unit named is a
  // fourth way of reading the same column.
  return `The three lines above are each rounded to the nearest ${PACK_SCALE}, so they differ by `
    + `one unit from their own sum. In rands: ${exact(operating)} plus ${exact(addBack)} is `
    + `${exact(ebitda)}.`;
}

/**
 * THE SAME NOTE OVER TWO COLUMNS, because the bridge now carries two.
 *
 * Either column may fail to foot as printed and they fail independently, so
 * the note names WHICH one it is explaining. A reader looking at the column
 * that does add must not be told it does not.
 */
export function bridgeRoundingNotes(
  current: { operating: number; addBack: number; ebitda: number },
  comparative: { operating: number; addBack: number; ebitda: number } | null,
): string | undefined {
  const currentNote = bridgeRoundingNote(current.operating, current.addBack, current.ebitda);
  const priorNote = comparative === null
    ? undefined
    : bridgeRoundingNote(comparative.operating, comparative.addBack, comparative.ebitda);
  if (currentNote === undefined && priorNote === undefined) return undefined;
  if (comparative === null) return currentNote;
  // NAMED, once there are two columns to confuse. A bare "the three lines
  // above" over a two-column bridge does not say which three.
  if (currentNote !== undefined && priorNote !== undefined) {
    return `Reporting period: ${currentNote} Comparative period: ${priorNote}`;
  }
  return currentNote !== undefined
    ? `Reporting period: ${currentNote}`
    : `Comparative period: ${priorNote}`;
}

/**
 * The convention, the two margins, and every ratio and day count the pack
 * prints — in the order a reader meets them.
 *
 * Fixed rather than derived from the pages: the highlight tiles and the
 * scorecard groups are both fixed lists, so a measure printed on one of them
 * is printed on every pack. A definition that appeared and disappeared with
 * the data would make page 12 a different page each month, which is the
 * opposite of what a basis of preparation is for.
 */
const TERMS: PackDefinition[] = [
  {
    // STATED, because §7.1 criterion 8 asks for one number convention stated
    // and applied. A rendered pack showed `(1 546)`, `−1348.0%` and `-0.14`
    // within a few rows of each other on one sheet — an accounting bracket, a
    // U+2212 and an ASCII hyphen for the same idea — and page 12 named none of
    // them. `src/lib/format/money.ts` is where the applying happens.
    //
    // AND THE EXAMPLE IS OBVIOUSLY AN EXAMPLE. It was `(1 546)` — one unit
    // from the demo pack's headline loss of (1 545) and matching nothing in
    // the document, so a director reads it as a figure and goes looking for
    // it. A run of digits cannot be mistaken for a balance.
    term: 'Negative figures',
    definition: 'In brackets — (12 345) — for currency, percentages and ratios alike. No minus sign is used anywhere in this pack.',
  },
  {
    // THE DASH MEANT TWO THINGS AND THIS PAGE DEFINED NEITHER. `formatMoney`
    // prints a measured zero as an en dash, and `ComparativeTable` printed the
    // same dash in a cell it had no figure for — so sheet 6's "Other expenses
    // – – –" (a real zero, 0.0% of revenue beside it) and sheet 8's prior and
    // change columns on three rows whose actual is n/m read identically. The
    // table now prints n/m in a derived cell of a not-meaningful row, which
    // leaves the dash one meaning; this is the sentence that states it.
    //
    // Said HERE rather than as a seventeenth term, beside the convention it
    // is most often mistaken for. A reader looking at a dash and wondering
    // whether it is a zero is reading this entry already.
    // AND THE FOURTH NOTATION, WHICH THIS PAGE DECLARED THREE OF.
    //
    // The statements print `<1` — in brackets where negative — for a real
    // amount that rounds to nothing at the stated scale, and page 12 named
    // brackets, the dash and n/m and not this. It sat on sheet 6 beside a
    // dash convention that means the opposite (a figure measured and nil), so
    // the one notation a reader is most likely to mistake for the dash was
    // the one not defined. Appended here rather than given a seventeenth
    // term: page 12 composes within 2mm of its box on live Brightsphere, and
    // this is the entry a reader looking at a small figure is already in.
    term: 'Not meaningful (n/m)',
    // AND TWO OF ITS CLAUSES WERE THE SENTENCES BESIDE THEM SAID TWICE. It
    // read "never a zero — which would say the measure was taken and found to
    // be nothing", and the next sentence defines the dash as exactly that
    // zero; and it closed "— an amount smaller than one unit of the scale in
    // the column header, not a nil", which is "too small to show at this
    // scale" again with the dash contrast restated. Page 12 is the page with
    // no slack left, the Rounding fact now carries a clause about ratios this
    // pack stated nowhere, and this is where the paper for it comes from.
    // Every notation the entry declares — n/m, the dash, `<1` and `(<1)` —
    // is still declared.
    definition: 'A measure the figures cannot support. The pack prints the reason rather than a number, never a zero. A dash (–) is that zero: a figure measured and nil. A real amount too small to show at this scale prints as <1, or (<1) where it is negative.',
  },
  {
    term: 'Gross margin',
    definition: 'Gross profit (revenue less cost of sales), as a percentage of revenue.',
  },
  {
    term: 'Operating margin',
    definition: 'Operating profit as a percentage of revenue.',
  },
  {
    term: 'Net profit margin',
    definition: 'Net profit, as a percentage of revenue.',
  },
  {
    term: 'Working capital',
    definition: 'Current assets less current liabilities, in rand.',
  },
  {
    term: 'Current ratio',
    definition: 'Current assets divided by current liabilities.',
  },
  {
    term: 'Cash ratio',
    definition: 'Cash and cash equivalents divided by current liabilities.',
  },
  {
    term: 'Debt-to-equity',
    definition: 'Total liabilities divided by total equity. Not reported on negative equity: the quotient inverts.',
  },
  {
    term: 'Interest cover',
    definition: 'Operating profit divided by net interest expense. This pack captures no interest expense line, so it is reported as not meaningful.',
  },
  {
    term: 'Debtor days',
    // 365, NOT THE DAYS IN THE PERIOD. `calculateExtendedRatios` multiplies
    // by 365 and always has; this page said "the days in the window", and
    // creditor days then could not be reproduced from its own definition —
    // 1 035 × 805 ÷ 245 implies payables of 3 401 against total liabilities
    // of 2 281, which is impossible, while ÷ 365 gives 2 283. The figures
    // were right and the definition was wrong. The trends page IS a
    // days-in-the-month figure (`packTrendService.debtorDays`), which is why
    // the two windows are still distinguished here.
    definition: 'Trade receivables over revenue, times 365 — an annualised figure on the scorecard and highlights, whatever the length of the reporting period. The trends page instead multiplies each month\'s ratio by the days in that month, so the two do not agree.',
  },
  {
    term: 'Creditor days',
    definition: 'Trade payables over cost of sales, times 365 — annualised, whatever the length of the reporting period. Not reported where there is no cost of sales.',
  },
  {
    term: 'Cash conversion cycle',
    definition: 'Debtor days plus inventory days, less creditor days — each annualised on 365 days, as above. Not reported where no account is classified as inventory.',
  },
  {
    term: 'Operating cash flow',
    definition: 'Cash generated by operations before investing and financing activities.',
  },
  {
    // MOVED HERE FROM THE SCORECARD PAGE, which had to drop two notes for
    // space and then told the reader in a footnote that it had. A definition
    // of how a target is scored belongs with the other definitions, on the
    // page that has room for it.
    term: 'Scored, unscored and not meaningful',
    definition: 'Scored against the platform\'s default target. A metric with no target is unscored rather than assumed met; one the figures cannot support is not meaningful. Neither counts as a pass or a miss.',
  },
];

/**
 * The definitions page 12 prints, with EBITDA's bridge built against this
 * pack's own figures.
 *
 * @param p The document's provenance map. The bridge's three lines resolve
 *   through it at the same sources the group-results table prints, so a
 *   reader adding up the bridge gets the number on page 5 by construction and
 *   the integrity gate refuses the pack if they ever diverge.
 */
export function buildDefinitions(set: PackFigureSet, p: PackFigureProvenance): PackDefinition[] {
  const current = set.current;
  const operating = operatingProfitOf(current);
  const ebitda = calculateExtendedRatios(toFinancialData(current)).ebitda;
  const charged = current.depreciation !== 0;
  // THE COMPARATIVE COLUMN, AND THE REASON IT EXISTS.
  //
  // Page 5 states the comparative period's EBITDA in the same sentence as the
  // current one, and until now nothing in the pack reconciled it. On the demo
  // company it equals comparative operating profit to the rand, which is a
  // nil add-back — true, and indistinguishable to a reader from a measure the
  // pack could not compute. §7.1 criterion 12 asks for the bridge, not for
  // the bridge of whichever column the pack finds convenient.
  //
  // Read through the SAME two calls as the current column, off `set.prior`,
  // so the two columns cannot be computed different ways; null where there is
  // no comparative period at all (R3), which leaves the bridge one column
  // wide rather than printing an empty second.
  const prior = set.prior === null ? null : {
    operating: operatingProfitOf(set.prior),
    addBack: set.prior.depreciation,
    ebitda: calculateExtendedRatios(toFinancialData(set.prior)).ebitda,
  };
  // A NEGATIVE ADD-BACK IS NOT A SIGN ERROR, AND THE PAGE HAD TO SAY WHICH.
  //
  // Brightsphere's bridge read "Add back: depreciation and amortisation
  // (152)", taking operating profit (1 819) to EBITDA (1 971) — arithmetic
  // that is internally consistent under a definition saying "PLUS the
  // depreciation and amortisation CHARGED in the period", which invites a
  // reader to conclude the sign is wrong. It is not: `depreciation` is the
  // signed period movement on the classifier's `depreciation_expense` band
  // (`aggregateFigures`), those accounts sit inside operating expenses, and a
  // period whose net movement on them is a CREDIT — a reversal or a
  // correction — has already had that credit raise its operating profit. The
  // add-back takes it back out, in the direction that keeps EBITDA a measure
  // before depreciation. Unexplained, that is a number a director stops at.
  const credited = current.depreciation < 0;

  const ebitdaDefinition: PackDefinition = {
    term: 'EBITDA',
    // THE CREDITED BRANCH SAYS THE SAME THING IN A THIRD OF THE WORDS, AND
    // THAT IS A CORRECTION RATHER THAN A TRIM. Written as a paragraph appended
    // to the shared preamble, it cost the glossary 7.4mm — and page 12 has
    // about 1.7mm of paper to spare, so on the live Brightsphere ledger, whose
    // depreciation movement IS a net credit, it pushed the page over and the
    // fitter paid for it by taking SIX of the eight basis-of-preparation facts
    // including the ledger version. A sentence explaining a sign cannot cost
    // the page its audit anchor.
    //
    // It is shorter because the preamble is not repeated: "plus the
    // depreciation and amortisation charged in the period" is what the
    // credited case has to contradict, so the branch now supplies its own
    // clause instead of arguing with a phrase above it. Every claim survives —
    // that the movement is a net credit, that the add-back is therefore
    // negative, that EBITDA lands below operating profit, and that this is the
    // ledger's movement rather than a sign error.
    definition: credited
      ? 'Earnings before interest, tax, depreciation and amortisation — a non-IFRS measure: '
        + 'operating profit plus the period\'s movement on depreciation and amortisation. That '
        + 'movement is a NET CREDIT here — more reversed out of those accounts than posted in — so '
        + 'the add-back is negative and EBITDA sits below operating profit. The ledger\'s movement, '
        + 'not a sign error.'
      : 'Earnings before interest, tax, depreciation and amortisation — a non-IFRS measure, taken '
        + 'from operating profit (already stated before interest and tax) plus the depreciation and '
        + 'amortisation charged in the period. '
        + (charged
          ? 'The bridge below is the whole of it; there are no other adjustments.'
          : 'None was charged this period, so the add-back is nil and EBITDA equals operating '
            + 'profit — what the ledger says, not a measure the pack failed to compute.'),
    reconciliation: [
      {
        label: 'Operating profit (IFRS)',
        figure: p.figure(OPERATING_PROFIT_SOURCE, operating, 'money'),
        // `${source}.prior` is the convention every comparative figure in the
        // pack is recorded under — see `packStatementTables.buildRow` — so the
        // prior column of this bridge and the prior column of a statement
        // table cannot be two different readings of one source.
        ...(prior === null ? {} : { comparative: p.figure(`${OPERATING_PROFIT_SOURCE}.prior`, prior.operating, 'money') }),
      },
      {
        label: 'Add back: depreciation and amortisation',
        figure: p.figure(DEPRECIATION_SOURCE, current.depreciation, 'money'),
        ...(prior === null ? {} : { comparative: p.figure(`${DEPRECIATION_SOURCE}.prior`, prior.addBack, 'money') }),
      },
      {
        label: 'EBITDA',
        figure: p.figure(EBITDA_SOURCE, ebitda, 'money'),
        ...(prior === null ? {} : { comparative: p.figure(`${EBITDA_SOURCE}.prior`, prior.ebitda, 'money') }),
      },
    ],
    reconciliationNote: bridgeRoundingNotes(
      { operating, addBack: current.depreciation, ebitda },
      prior,
    ),
  };

  // EBITDA sits with the profitability terms rather than at the end: it is
  // the one measure on this page a reader came looking for.
  return [...TERMS.slice(0, 5), ebitdaDefinition, ...TERMS.slice(5)];
}
