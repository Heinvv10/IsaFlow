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
 * not explain. The prose was moved to 365 then, and that was the wrong half
 * to move: 365 over a six-month window's revenue reads six months of sales
 * as a year's and doubles the count (the AFS KPIs never did it — they take
 * the period's days). The engine now multiplies by the window's own days
 * (`FinancialData.periodDays`), and the definitions say so again.
 */
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { OPERATING_PROFIT_SOURCE, operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { packFiguresToFinancialData } from './packScorecard';
import {
  bridgeRoundingNote,
  bridgeRoundingNotes,
  DA_ADD_BACK,
  DEPRECIATION_SOURCE,
  EBITDA_SOURCE,
} from './packEbitdaBridge';
import { DEBTOR_DAYS_TRENDS_CLAUSE, TERMS } from './packGlossaryTerms';
import type { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackDefinition } from './packPageModel';

/** EBITDA's sources, its add-back wording and the bridge's rounding notes
 *  live in `packEbitdaBridge.ts`, and the fixed entries in
 *  `packGlossaryTerms.ts`, for the 300-line cap. Re-exported because every
 *  existing caller imports them here. */
export { bridgeRoundingNote, bridgeRoundingNotes, DA_ADD_BACK, DEPRECIATION_SOURCE, EBITDA_SOURCE };

/** The last of the margin terms — EBITDA is printed directly after it. */
const EBITDA_FOLLOWS = 'Net profit margin';

/**
 * THE ENTRIES THAT ARE NOT MEASURES, AND SO ARE NOT DRIVEN BY WHAT IS
 * PRINTED.
 *
 * `Negative figures`, the n/m entry and the scoring entry describe the pack's
 * NOTATION — how to read a bracket, a dash, an unscored row — and a reader
 * meets that notation on nine sheets without any of those three phrases
 * appearing as a term anywhere. Filtering them by the same rule the measures
 * use would delete the key to the document.
 */
/**
 * The printed labels an entry is ABOUT, where its term is not one of them.
 *
 * `definitionsPrintedBy` asks whether the document prints the term, and one
 * entry covers three rows of page 8's cash statement under a heading that is
 * none of their labels. Without this the entry that defines all three would
 * be filtered out as a definition of something the pack does not print, which
 * is the exact opposite of true.
 */
export const TERMS_COVERING: Readonly<Record<string, readonly string[]>> = {
  'Operating, investing and financing cash flow': [
    'Operating cash flow', 'Investing cash flow', 'Financing cash flow',
  ],
};

export const NOTATION_TERMS: ReadonlySet<string> = new Set([
  'Negative figures',
  'Not meaningful (n/m)',
  'Scored, unscored and not meaningful',
]);

/**
 * THE GLOSSARY IS WHAT THE PACK PRINTS, NOT A LIST SOMEBODY MAINTAINS.
 *
 * Page 12 defined `Net profit margin` on both companies and neither pack
 * prints that measure on any sheet — a definition of something a director
 * cannot find, on the page whose job is to explain what they CAN find. It is
 * the same defect class as the debtor-days entry that described a panel
 * Brightsphere does not draw, and that one was fixed by hand for that one
 * term; hand-fixing the next is how it recurs.
 *
 * So a MEASURE entry survives only where the pack prints its term. Read off
 * the composed body pages rather than off the figure set, because the
 * question is what a reader can see: a measure computed and not printed is
 * not something a glossary owes them an entry for.
 *
 * The reverse direction — a measure printed with no entry — cannot be
 * enforced from here, because there is no list of "every measure" that is not
 * itself the thing being checked. `packGlossaryCoverage.test.ts` walks the
 * composed statements' own row labels and the scorecard's own metric names
 * and requires each to be defined or explicitly exempt, which is the same
 * question asked of the document instead of a list.
 */
export function definitionsPrintedBy(
  entries: PackDefinition[],
  /** Everything the body pages print, lower-cased. */
  printed: string,
): PackDefinition[] {
  return entries.filter((entry) => NOTATION_TERMS.has(entry.term)
    || printed.includes(entry.term.toLowerCase())
    || (TERMS_COVERING[entry.term] ?? []).some((label) => printed.includes(label.toLowerCase())));
}

/**
 * The definitions page 12 prints, with EBITDA's bridge built against this
 * pack's own figures.
 *
 * @param p The document's provenance map. The bridge's three lines resolve
 *   through it at the same sources the group-results table prints, so a
 *   reader adding up the bridge gets the number on page 5 by construction and
 *   the integrity gate refuses the pack if they ever diverge.
 */
export function buildDefinitions(
  set: PackFigureSet,
  p: PackFigureProvenance,
  /** The trend panels this pack draws — see `buildBasis`. */
  drawnPanelIds: ReadonlySet<string> = new Set(['trend-debtor-days']),
): PackDefinition[] {
  // The glossary entry that describes a drawing, on a pack that may not
  // contain it. Removed by identity from the one string that states it.
  const terms = drawnPanelIds.has('trend-debtor-days')
    ? TERMS
    : TERMS.map((t) => (t.definition.includes(DEBTOR_DAYS_TRENDS_CLAUSE)
      ? { ...t, definition: t.definition.replace(DEBTOR_DAYS_TRENDS_CLAUSE, '') }
      : t));
  const current = set.current;
  const operating = operatingProfitOf(current);
  const ebitda = calculateExtendedRatios(packFiguresToFinancialData(current)).ebitda;
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
    ebitda: calculateExtendedRatios(packFiguresToFinancialData(set.prior)).ebitda,
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
        + `operating profit plus ${DA_ADD_BACK}. That `
        + 'movement is a NET CREDIT here — more reversed out of those accounts than posted in — so '
        + 'the add-back is negative and EBITDA sits below operating profit. The ledger\'s movement, '
        // AND THAT THE RECONCILIATION IS ALL OF IT, which the other arm says
        // and this one dropped — on the company whose add-back is negative
        // and needs the assurance most. Its ONLY non-IFRS measure was
        // reconciled with no claim that the reconciliation was exhaustive.
        // Three words, because page 12 has about 1.7mm of paper: the other
        // arm's "(already stated before interest and tax)" is the acronym
        // above it restated, and is not what went missing.
        + 'not a sign error. No other adjustments.'
      // ONE WORDING FOR THE ADD-BACK, AND IT IS "MOVEMENT".
      //
      // This arm read "plus the depreciation and amortisation CHARGED in the
      // period" while page 5 of the same pack said "plus the MOVEMENT on
      // depreciation and amortisation" — the demo's basis page defining its
      // own measure in words its page 5 does not use. Both give +77 on that
      // company so nothing was disproved by it, and the credited arm below
      // already says "movement" precisely because Brightsphere's add-back is
      // a net credit of (152): "charged" would be false there. A wording that
      // is right on one company and wrong on the other is the wrong wording
      // even where the figures agree, so both arms and both pages now say the
      // one thing that is true in both directions.
      : 'Earnings before interest, tax, depreciation and amortisation — a non-IFRS measure, taken '
        + `from operating profit (already stated before interest and tax) plus ${DA_ADD_BACK}. `
        + (charged
          // A TABLE, AND THE PAGE CALLED IT A BRIDGE. The Colour key three
          // entries down says "on the bridges, green is an income line, red a
          // cost line" — and this one is two rows and a total in black. A
          // reader taking the key at its word looks for a colour that is not
          // there and concludes the pack failed to draw it. The word for what
          // is below is what the field is already called: a reconciliation.
          // "No other adjustments" pays the eight characters back, on the
          // tightest sheet in the pack.
          ? 'The reconciliation below is the whole of it; no other adjustments.'
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
  // the one measure on this page a reader came looking for. Placed by the
  // term it follows, not by a position that moves when a term is added.
  const after = terms.findIndex((t) => t.term === EBITDA_FOLLOWS);
  if (after === -1) {
    throw new Error(`buildDefinitions: the glossary has no '${EBITDA_FOLLOWS}' entry to place EBITDA after.`);
  }
  return [...terms.slice(0, after + 1), ebitdaDefinition, ...terms.slice(after + 1)];
}
