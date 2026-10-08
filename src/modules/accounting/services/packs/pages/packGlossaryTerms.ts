/**
 * Page 12's fixed glossary entries — the notation, the margins, and every
 * ratio and day count the pack prints. Split out of `packDefinitions.ts` for
 * the 300-line cap; `buildDefinitions` there places EBITDA among them.
 */
import { inScale } from '@/lib/format/money';
import type { PackDefinition } from './packPageModel';
import { PACK_SCALE } from './packScale';

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
/**
 * The half of the debtor-days entry that is about a PANEL, kept separate so
 * `buildDefinitions` can drop it on a pack that draws none — see the comment
 * on that entry. A constant rather than a second string: the sentence is
 * written once and removed by identity, so it cannot drift from the version
 * the glossary prints.
 */
export const DEBTOR_DAYS_TRENDS_CLAUSE =
  ' On the trends page that period is each month, so the two need not agree.';

export const TERMS: PackDefinition[] = [
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
    // AND THE POSITIVE SIDE, WHICH THIS ENTRY DID NOT STATE. `formatPct`
    // prefixes a `+` and `formatPctLevel`, `formatMoney` and `formatRatio` do
    // not, so the pack prints "+77.8%" in a change column and "626" in a
    // money column two centimetres apart. It is consistent within every
    // column and unambiguous, and it was the one convention in the pack that
    // page 12 applied without declaring.
    //
    // THE NOUN IS "CHANGE" AGAIN, AND NOW IT IS TRUE. For a while page 6's
    // % of revenue column printed "+100.0%" and page 9 a target of "+35.0%",
    // so the clause said "value". Those are levels, and a "+" on a level
    // claims a movement nobody measured: they print unsigned now
    // (`formatFigureText`), and only the change column takes the sign.
    //
    // The clause is an EXCLUSION and stays one: it says a + never sits on a
    // figure that is not positive, not that every positive figure takes one
    // (money does not — page 6 prints 626 unsigned two centimetres from
    // +77.8%). "Value" is the widest noun the exclusion is true of, and it is
    // one character shorter than the word it replaces.
    //
    // THE WORD IS "ONLY", AND IT IS FIVE CHARACTERS OF PAPER. The clause
    // began "A change carries a + where it is positive; a level and an amount
    // do not", which says the same in both directions and takes this entry to
    // a FOURTH line of its 83mm glossary column — enough, on the tightest
    // print fixture, to push page 12 into dropping its Colour note. "Only"
    // carries the exclusion in one word, and the entry is three lines as it
    // was; the minus-sign claim beside it is untouched.
    term: 'Negative figures',
    // AND THE RULE CARVES OUT THE PROSE, WHICH DOES NOT USE BRACKETS AND WAS
    // NOT MEANT TO. The pack's derived sentences print "Operating margin is a
    // negative 1522.9%" — no bracket and no minus — under a rule saying
    // negatives are bracketed, for currency, percentages and ratios alike.
    // Both are deliberate: `pctWithWord` names the direction in WORDS because
    // two captions once printed a bare magnitude above a table reading the
    // negative of it, and a bracketed percentage inside a sentence reads as
    // an aside rather than a sign. What was missing is the rule admitting it.
    //
    // "alike" pays for the clause and the entry does not move: this one has
    // between sixteen and eighteen characters of wrap on `liveDemoBridge`,
    // page 12 composes at 252.41mm of 255 before and after, and at nineteen
    // the fitter drops the Colour key. All three kinds are still listed, so
    // nothing the word emphasised has gone.
    // "IN PROSE, IN WORDS" IS TRUE OF PERCENTAGES AND OF NOTHING ELSE.
    // `pctWithWord` writes "a negative 1522.9%" in a sentence; money in a
    // sentence keeps its brackets — page 11 prints "trade receivables of
    // (330)" and page 7 "working capital stands at (3 821)" — so the rule as
    // written was contradicted by the pack on nearly every prose sheet. The
    // gate reads that as an imprecise sentence rather than an inconsistent
    // pack, and it is right: the practice is deliberate and only the
    // description was loose.
    //
    // AND IT IS PAID FOR OUT OF THIS ENTRY, which had under five characters
    // of wrap on `liveDemoBridge` — page 12 composes at 252.41mm of 255 there
    // and the fitter answers one more line by dropping a whole glossary
    // entry. "anywhere" was emphasis carrying nothing (nine), and "money" is
    // the word this pack uses for the thing "currency" named (four). The
    // scope — a PERCENTAGE, in PROSE — is the whole of the correction and
    // both halves of it survive.
    definition: 'In brackets — (12 345) — for money, percentages and ratios; a percentage in prose, in words. No minus sign is used in this pack. Only a positive change takes a +.',
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
    // AND THE DASH CARRIES TWO MEANINGS AGAINST A SENTENCE HERE THAT SAID IT
    // CARRIED ONE — the same defect this entry was written to close, one
    // column further on.
    //
    // "A dash (–) is that zero: a figure measured and nil" is a
    // single-meaning claim, and the scorecard breaks it: in page 9's TARGET
    // column a dash means NO TARGET EXISTS, which is not a target of nil.
    // The proof that the two are distinct is on the sheet itself — a cash
    // ratio of (0.16) against a nil target would be a MISS, and the row
    // reads UNSCORED. Four rows of the demo scorecard and five of
    // Brightsphere's use the dash that second way, under a page that has
    // told the reader it has one meaning.
    //
    // The exception is STATED under `Scored, unscored and not meaningful`
    // rather than here, because that is the entry that owns the TARGET
    // column and already says a metric with no target is unscored rather
    // than assumed met — the dash is what that sentence looks like on the
    // paper. This entry keeps only the hook, so a reader who meets a dash
    // and reads this first is not left with the universal.
    //
    // BOTH HALVES COST THE PAGE NOTHING, AND THAT IS WHY THEY ARE WORDED AS
    // THEY ARE. Page 12 has 2.59mm of paper on the live demo fixture whose
    // EBITDA bridge rounds (`liveDemoBridgeInput`) — one added line is
    // 2.58mm, which would leave 0.01 — and the first wording, the exception
    // written out in full in THIS entry, put the sheet over and made it drop
    // a basis fact. Measured per entry: this one has about ten characters of
    // wrap left and the Scored entry about fifty, so the hook is eighteen
    // characters here and the sentence sixty there, and page 12 composes at
    // 252.41mm of 255 exactly as it did before.
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
    definition: 'A measure the figures cannot support. The pack prints the reason rather than a number, never a zero. A dash (–) is that zero: a figure measured and nil, bar Scored below. A real amount too small to show at this scale prints as <1, or (<1) where it is negative.',
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
    // IN THE PACK'S SCALE, NOT "IN RAND". The tile and page 7 print it in
    // R'000, so Velocity Fibre's (48 746) read as R48 746 to anyone taking
    // this definition at its word. Taken from the constant every figure is
    // scaled by, so the two cannot part again.
    definition: `${inScale('Current assets less current liabilities', PACK_SCALE)}.`,
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
    definition: 'Operating profit divided by interest expense: the period\'s interest and similar finance costs, excluding bank charges, gross of interest earned. Not stated where none is recorded.',
  },
  {
    term: 'Debtor days',
    // THE DAYS IN THE PERIOD, AND THE ENGINE NOW MULTIPLIES BY THEM. This
    // entry once said "times 365" because `calculateExtendedRatios` did, and
    // the definition was made to match the code — which was the wrong half
    // to move: 365 over a six-month window's revenue reads six months of
    // sales as a year's, and a book of 50 days printed 99. The engine takes
    // the window's days (`FinancialData.periodDays`), each column its own
    // window's, and the trends page has always taken each month's — one
    // rule, so the trends clause names the window and nothing else.
    // THE SECOND SENTENCE IS ABOUT A PANEL THIS PACK MAY NOT DRAW.
    // Brightsphere's revenue is not a positive base, so its trends page draws
    // no debtor-days panel at all — and its sheet 12 defined the variant that
    // page would have printed. A glossary entry describing a drawing the
    // document does not contain is the same defect as a footnote pointing at
    // a page that carries nothing.
    definition: `Trade receivables over revenue, times the days in the period that revenue covers. Not reported where the period's length cannot be measured.${DEBTOR_DAYS_TRENDS_CLAUSE}`,
  },
  {
    term: 'Creditor days',
    definition: 'Trade payables over cost of sales, times the days in the period that cost covers. Not reported where there is no cost of sales or the period\'s length cannot be measured.',
  },
  {
    term: 'Cash conversion cycle',
    // INVENTORY DAYS IS DEFINED WHERE IT IS USED. It appeared only inside
    // this sentence — a term used in a definition and defined nowhere, on a
    // glossary page — and it is not a measure the pack prints anywhere else,
    // so it gets a clause here rather than an entry of its own on the
    // tightest sheet in the pack.
    definition: 'Debtor days plus inventory days (inventory over cost of sales, times the same days), less creditor days. Not reported where no account is classified as inventory.',
  },
  {
    // PAGE 8'S THREE ROWS, DEFINED ONCE AND ALIKE.
    //
    // Operating cash flow was defined here; investing was explained only
    // where page 8 prints its reason for an n/m ("taken from capital
    // expenditure"); financing was defined in neither place. Three rows of
    // one statement, three different treatments, on both companies — and a
    // director looking up the one that is missing finds the other two.
    //
    // ONE ENTRY RATHER THAN THREE because they are one statement's three
    // bands and a reader wants them beside each other, and because page 12 is
    // the tightest sheet in the pack: three terms and three definitions cost
    // it 13mm it does not have, and this says the same thing in a third of
    // the paper. See `TERMS_COVERING` for how the printed-measure filter
    // knows what this entry is about.
    term: 'Operating, investing and financing cash flow',
    definition: 'Cash from operations before the other two; cash spent on or raised from capital assets; and cash raised from or repaid to funders and shareholders.',
  },
  {
    // MOVED HERE FROM THE SCORECARD PAGE, which had to drop two notes for
    // space and then told the reader in a footnote that it had. A definition
    // of how a target is scored belongs with the other definitions, on the
    // page that has room for it.
    term: 'Scored, unscored and not meaningful',
    definition: 'Scored against the platform\'s default target. With no target a metric is unscored, not assumed met, and its TARGET cell prints a dash rather than a nil target; lacking a recorded input it is not stated; unsupported by the figures, not meaningful. None is a pass or a miss.',
  },
];
