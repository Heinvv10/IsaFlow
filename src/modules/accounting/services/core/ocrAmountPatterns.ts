/**
 * The amount grammar the OCR regex fallback reads invoices and till slips with.
 *
 * Split out of `ocrExtractionService` so that file stays inside the 300-line
 * cap, and because every rule here is about how a NUMBER or a LABEL is printed
 * — nothing in this module knows what a document is.
 *
 * How a figure itself is spelled — the decimal comma, the malformed-artefact
 * refusal, the registration-number test — lives next door in
 * `ocrAmountParsing`; this module is labels.
 *
 * Two defects shaped it, and each one is a rule below rather than a comment:
 *
 *   - The label boundary. `Total` with nothing to its left matched the `total`
 *     inside `Subtotal`, `Sub Total` and `Sub-Total`, and `String.match`
 *     returns the FIRST hit — so the VAT-exclusive figure became the total.
 *   - The VAT label. Every separator was optional, so a letterhead
 *     "VAT 4123456789" read a registration number as an amount.
 *
 * The third is the one that kept coming back, and it is why the LABEL
 * VOCABULARY below exists as data rather than as three hand-spelled regexes:
 * a guard was fixed for one spelling of a label at a time — `Sub Total`, then
 * `Sub  Total`, then `Excl VAT` — while every sibling spelling of the SAME
 * concept stayed live. `Nett Total`, `Ex VAT` and `Sub.Total` each reproduced
 * the original money defect after it was declared closed. Guard and pattern are
 * now both built from one alternation per concept, so a label the module knows
 * enough to REFUSE as the payable total is always a label it knows enough to
 * READ as the net, and vice versa. Adding a spelling is one entry here plus one
 * row in the k076 table — never a new regex.
 *
 * The fourth is what the vocabulary itself got wrong, and it is why nothing
 * below spells a separator or a stem by hand any more: `NET_LABEL` carried a
 * hardcoded `S[./]` while `SEP` admitted five characters, so `S-Total` — the
 * one spelling of that family the guard did not refuse and the pattern did not
 * read — came back as the payable total, and `NOT_A_TAX_LABEL` carried a
 * hardcoded `[\s-]*` so `Total Excl_VAT 1000.00` reported R1 000 of INPUT TAX
 * on an R1 150 invoice. A shared alternation that one member bypasses is not a
 * shared alternation. Every separator below is `SEP`; every abbreviation is
 * built from `ABBREV_TAIL`; every net label is `NET_LABEL`.
 */

import { AMOUNT } from './ocrAmountParsing';

/* ------------------------------------------------------------------------- *
 * THE LABEL VOCABULARY
 *
 * Three concepts, one alternation each. Every guard and every pattern below is
 * built from these, which is the whole mechanism: a guard narrower than its
 * pattern loses the figure entirely, a guard wider than its pattern mis-reads
 * it, and both failure modes have shipped from this file.
 * ------------------------------------------------------------------------- */

/**
 * Whatever the printer or the OCR pass put between the words of a label.
 *
 * The quantifier is the point, and so is the class. `Sub-Total` misread as
 * `Sub.Total` or `Sub_Total` is routine OCR confusion, `S/Total` is a real
 * abbreviation, and a column layout prints two spaces, a tab or a newline.
 * `*` also subsumes the joined `SubTotal`. JavaScript (unlike most engines)
 * allows a variable-length lookbehind, which is what lets the guards reuse it.
 */
const SEP = String.raw`(?:[\s._/]|-(?!\d))*`;

/**
 * What stands between a label and its figure: an optional colon or dash, an
 * optional currency mark, and whatever whitespace the column layout printed.
 *
 * A hyphen GLUED to the digits is a minus sign and not a separator, here and in
 * `SEP` above. While both classes ate it unconditionally, a credit note
 * printing "Total -115.00" came back +115 with no warning — `detectDocumentType`
 * answers `credit_note` correctly, so the sign was the only thing lost, and a
 * refund read as a purchase reverses the direction of the posting. `-(?!\d)`
 * is what separates the two spellings: `Total - 115.00` and `Total -  115.00`
 * keep the dash as a separator, `Total -115.00` reads the sign. A dash printed
 * as a separator with NO space after it is the one ambiguous spelling, and here
 * it reads negative, which the auto-post gate refuses. That is NOT automatically
 * true of every pattern: see `VAT_PATTERNS[1]`, whose separator is required.
 */
const VALUE_SEP = String.raw`\s*(?::|-(?!\d))?\s*(?:ZAR|R)?\s*`;

/**
 * "Excluding" and "Including", in every abbreviation a document prints.
 *
 * `Ex`, `Exc`, `Excl`, `Excluding`, each with or without a full stop — and the
 * same for `In`. The shortest forms are not decoration: `Price Ex VAT 1000.00`
 * is ordinary SA quote spelling, and while the guard required the letters `cl`
 * it read that 1000.00 as the TAX on an R1 150 invoice — an R1 000 input-tax
 * claim, balanced, auto-posted, on a document that says R150.
 */
const ABBREV_TAIL = String.raw`c(?:l(?:uding)?)?`;
const EXCL = String.raw`Ex(?:${ABBREV_TAIL})?\.?`;
const INCL = String.raw`In(?:${ABBREV_TAIL})?\.?`;

/**
 * The same marker, minus the bare two-letter form.
 *
 * `Total Excl 1000.00` prints no tax word, so the marker is the only evidence
 * the figure is a net — and `Ex` alone is too common a fragment to read that
 * way with nothing corroborating it. Spelled from `ABBREV_TAIL` rather than by
 * hand: a narrower member of the vocabulary is fine, a member that quietly
 * spells its own stem is what let `S-Total` through.
 */
const EXCL_LONG = String.raw`Ex${ABBREV_TAIL}\.?`;

/** `Total` and the Afrikaans `Totaal`, spelled once so every guard and pattern learns both. */
const TOTAL_WORD = String.raw`Totaa?l`;

/** The tax word, with or without the full stops of `V.A.T.`. */
const VAT_WORD = String.raw`V\.?A\.?T\.?`;
const TAX_WORD = String.raw`(?:${VAT_WORD}|Tax)`;

/**
 * The noun a document prints AFTER the tax word: `VAT Amount`, `VAT Total`,
 * `Tax Amount`.
 *
 * It used to be admitted after `Tax` and nowhere after `VAT`, so the two halves
 * of one concept disagreed by a single spelling: `Tax Amount 0.00` read zero
 * and `VAT Amount 0.00` read NOTHING. A null `vatAmount` is not a null result
 * downstream — `validateReceiptExtraction` only warns, and
 * `buildExpenseJournalFromReceipt` then discards the printed subtotal and
 * DERIVES 15% of the total. So a zero-rated till slip that prints its VAT as
 * zero produced an invented input-tax claim, balanced and inside the auto-post
 * gate: verbatim the defect the bare-column form below exists to prevent,
 * reached through a sibling spelling of the same label.
 *
 * `Total` is in here rather than only in `NOT_A_SUBTOTAL`: refusing to read
 * `VAT Total 150.00` as the payable total is half the answer, and reading it as
 * the tax is the other half.
 */
const TAX_NOUN = String.raw`(?:${SEP}(?:Amount|${TOTAL_WORD}|Value))?`;

/**
 * A label that means "this is the VAT-EXCLUSIVE figure", not the amount due.
 *
 * `Nett?` is here because of the second round of exactly this defect: the file
 * read `Nett Total` as a subtotal but its guard knew only `Sub`, and since the
 * label CONTAINS the word `Total`, `String.match`'s leftmost hit made the net
 * the payable total. With no VAT line printed the builder then derives 15% of
 * it, so the entry balances at the wrong figure and posts unattended.
 *
 * The abbreviated `S Total` takes `SEP` like every other member. It used to
 * take a hardcoded `S[./]`, which admitted `S.Total` and `S/Total` and left
 * `S-Total`, `S_Total` and `S Total` — the hyphen being the commonest of the
 * three — refused by neither guard nor pattern: measured, `S-Total 1000.00 /
 * VAT 150.00 / Total Due 1150.00` came back total=1000, subtotal=850, vat=150,
 * which balances, clears the auto-post gate and credits the bank R150 short of
 * the payment that will land on the statement.
 */
const NET_LABEL = String.raw`(?:Sub${SEP}${TOTAL_WORD}|S${SEP}${TOTAL_WORD}|Nett?(?![A-Za-z])(?:${SEP}(?:${TOTAL_WORD}|Amount|Value))?|Goods${SEP}Value)`;

/**
 * What may stand in front of an inclusive or exclusive marker: `Amount Excl
 * VAT`, `Price Ex VAT`, `Sub Total Excl VAT`.
 *
 * The net labels come from `NET_LABEL`, not from a hand-spelled `Sub${SEP}Total`
 * — that copy knew one member of a four-member alternation.
 */
const NET_PREFIX = String.raw`(?:${TOTAL_WORD}|Amount|Price|Value|${NET_LABEL})`;

/**
 * Not the `Total` inside a net label.
 *
 * `(?<![A-Za-z])` rejects a letter immediately before the label, covering the
 * joined `Subtotal`. The second lookbehind is the other half and spells the
 * same `Sub`/`Nett`/`S` stems as `NET_LABEL` over the same `SEP`, plus the
 * tax word — a separator admitted by one and not the other is exactly how
 * `S-Total` ended up being read as the amount payable — the
 * `Total` inside `VAT Total` is no more the payable total than the one inside
 * `Sub Total`, and while it was read as one, `Sub Total 1000 / VAT Total 150 /
 * Total Due 1150` came back with a payable of R150 and no tax at all. The inner
 * `\b` is what keeps it from eating ordinary words: without it `Sales Total`
 * and `Syntax Total` would be refused because they merely END in those letters.
 */
const NOT_A_SUBTOTAL = String.raw`(?<![A-Za-z])(?<!\b(?:Sub|Nett?|S|${TAX_WORD})${SEP})`;

/**
 * Not the `VAT`/`Tax` inside a TOTAL or a NET label.
 *
 * "Total Excluding VAT 1 000.00" and "Total Including VAT 1 150.00" are the
 * ordinary SA invoice spelling, and both put the bare word VAT in front of an
 * amount that is not the tax. Every abbreviation of both markers is refused
 * here and read by `SUBTOTAL_PATTERNS`/`TOTAL_PATTERNS` instead.
 *
 * The separator is `SEP`, and it has to be: while this guard spelled its own
 * `[\s-]*`, `Total Excl_VAT 1000.00 / Total Due 1150.00` measured vat=1000 —
 * the net read as the tax, an R1 000 input-tax claim on an R1 150 invoice,
 * balanced (the subtotal is derived as total − vat) and inside the auto-post
 * gate. Verbatim the defect `EXCL` was written to end, reached through a
 * separator the shared class admits and this copy did not.
 */
const NOT_A_TAX_LABEL = String.raw`(?<![A-Za-z])(?<!\b(?:${EXCL}|${INCL})${SEP})`;

/**
 * A label that names the amount payable without the word `Total`. It only
 * improves the GUESS the capture screen offers: a payable under a label missing
 * from here is still a figure larger than the total, which `ocrLargerFigure`
 * refuses on. Never grow it to close a posting defect — that race was lost six
 * times. A bare `Balance` read `Smart Shopper Balance 45.00` as the payable.
 */
const PAYABLE_LABEL = String.raw`(?:(?:Amount|Balance)${SEP}(?:Due|Owing|Payable)|Payable|T[eo]${SEP}(?:Betaal|Pay)|TTL)`;

/** The payable total. */
export const TOTAL_PATTERNS: RegExp[] = [
  // The parenthesised qualifier is `TOTAL (VAT INCL) 1150.00`, one of the most
  // common SA till-slip spellings. Nothing could cross the bracket, so the
  // document came back with NO total — not a wrong figure, a 400 on an
  // otherwise readable slip.
  new RegExp(String.raw`${NOT_A_SUBTOTAL}(?:(?:Grand|Invoice)${SEP})?${TOTAL_WORD}${SEP}(?:\([^)]*\))?\s*(?:Due|Amount|Payable)?${VALUE_SEP}${AMOUNT}`, 'i'),
  new RegExp(String.raw`(?<![A-Za-z])(?<!\bAccounts${SEP})${PAYABLE_LABEL}${VALUE_SEP}${AMOUNT}`, 'i'),
  // The inclusive marker, with its prefix OPTIONAL — the same shape
  // `SUBTOTAL_PATTERNS[1]` gives the exclusive twin. While the prefix was
  // mandatory here, a bare `Incl VAT 1150.00` was refused by
  // `NOT_A_TAX_LABEL` as the tax and read back by nothing at all: total,
  // subtotal and VAT all null, and `validateReceiptExtraction` answered 400 on
  // a legible slip. A guard narrower than its pattern loses the figure; this
  // was a guard with no pattern behind it.
  new RegExp(String.raw`${NOT_A_SUBTOTAL}(?:${NET_PREFIX}${SEP})?${INCL}${SEP}${TAX_WORD}${VALUE_SEP}${AMOUNT}`, 'i'),
];

/**
 * The VAT amount, most specific label first.
 *
 * The bare column form is not optional: a till slip prints "VAT      0.00" with
 * nothing but whitespace between, and dropping it does not merely lose the
 * figure — `buildExpenseJournalFromReceipt` derives 15% of the total whenever
 * `vatAmount` is null, so a document stating the VAT is ZERO (zero-rated
 * foodstuffs, routine in SA retail) produced an invented input-tax claim that
 * the document itself denies.
 *
 * The rate form's `(?:@|\()?` is optional so that "VAT 15% 150.00" reads 150
 * rather than nothing; the `(?![\d.,]*\s*%)` guard stops the bare column and
 * the `Tax` form reading the RATE as the amount (`Tax 15% 150.00` read 15).
 *
 * The generic `Tax` form is LAST, BELOW the bare VAT column, and the order is
 * load-bearing rather than stylistic. `extractVatAmount` takes the first
 * pattern that yields any candidate at all, so while `Tax` ranked above the
 * bare form, any non-VAT tax or levy line — routine on the hotel and airline
 * bills `MERCHANT_PATTERNS` explicitly routes — outranked the real VAT line:
 * "Tourism Levy Tax 12.00 / VAT 150.00" extracted 12.00, and with the subtotal
 * derived as total − 12 the entry still BALANCED and auto-posted, R138 of input
 * tax unclaimed and the VAT201 input box short by the same.
 */
export const VAT_PATTERNS: RegExp[] = [
  new RegExp(String.raw`${NOT_A_TAX_LABEL}${VAT_WORD}${TAX_NOUN}\s*(?:@|\()?\s*\d+(?:[.,]\d+)?\s*%\s*\)?${VALUE_SEP}${AMOUNT}`, 'gi'),
  // The separator here is REQUIRED, so excluding a glued dash from it did not
  // make `VAT-0.00` read negative — it made it read NOTHING, and a null VAT is
  // not a refusal downstream: the builder derives 15%, an invented R13.04 claim
  // on a zero-rated slip. `(?=-\d)` accepts the glued dash without consuming
  // it, so `AMOUNT` reads the sign: `VAT-0.00` is 0, `VAT-150.00` is -150.
  new RegExp(String.raw`${NOT_A_TAX_LABEL}${VAT_WORD}${TAX_NOUN}\s*(?::|-(?!\d)|(?=-\d))\s*(?:ZAR|R)?\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`${NOT_A_TAX_LABEL}${VAT_WORD}${TAX_NOUN}\s+(?:ZAR|R)\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`${NOT_A_TAX_LABEL}${VAT_WORD}${TAX_NOUN}\s+${AMOUNT}(?![\d.,]*\s*%)`, 'gi'),
  new RegExp(String.raw`${NOT_A_TAX_LABEL}(?:(?:Output|Input)${SEP})?Tax${TAX_NOUN}(?:\s*(?:@|\()?\s*\d+(?:[.,]\d+)?\s*%\s*\)?)?${VALUE_SEP}${AMOUNT}(?![\d.,]*\s*%)`, 'gi'),
];

/**
 * The VAT-exclusive subtotal — the same vocabulary the guards above refuse.
 *
 * While the two disagreed, "Sub - Total 1000.00" was correctly refused as the
 * payable total and then not recognised as the subtotal either, so the figure
 * was simply lost. A label the file knows enough to reject has to be a label
 * the file knows enough to read; `k076-ocr-label-boundaries` asserts that
 * correspondence label by label.
 */
export const SUBTOTAL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`(?<![A-Za-z])${NET_LABEL}${VALUE_SEP}${AMOUNT}`, 'i'),
  new RegExp(String.raw`(?<![A-Za-z])(?:${NET_PREFIX}${SEP})?${EXCL}${SEP}(?:of${SEP})?${TAX_WORD}${VALUE_SEP}${AMOUNT}`, 'i'),
  new RegExp(String.raw`(?<![A-Za-z])${NET_PREFIX}${SEP}${EXCL_LONG}(?![A-Za-z])${VALUE_SEP}${AMOUNT}`, 'i'),
];

/**
 * A summary line, which is where the line items stop.
 *
 * Built from the same vocabulary so that a label `SUBTOTAL_PATTERNS` reads as
 * the net cannot also be collected as an item: while the terminator knew only
 * `Sub[\s-]*Total`, a `Nett Total` summary line was pushed into the item list.
 * The `NET_PREFIX` in front of the exclusive marker is the last place the two
 * had drifted apart — `SUBTOTAL_PATTERNS[1]` read `Amount Excl VAT 1000.00` as
 * the net while this list stopped at the bare `Excl VAT`, so the summary line
 * was collected as an R1 000 expense item as well.
 *
 * One branch per pattern above, and that is the invariant `k076` asserts: the
 * inclusive marker had none at all, so `Incl VAT 1150.00` was both unreadable
 * as a total and collected as a phantom R1 150 expense line; and the bare
 * `Total Excl 1000.00` that `SUBTOTAL_PATTERNS[2]` reads had none either.
 * `(?![A-Za-z])` is what keeps the word-shaped branches from eating an item —
 * without it `Taxi fare` terminated the list on `Tax` and `Exclusive of
 * delivery` terminated it on `Excl`.
 */
export const SUMMARY_LINE_START = new RegExp(
  String.raw`^(?:${NET_LABEL}`
  + String.raw`|(?:(?:Grand|Invoice)${SEP})?${TOTAL_WORD}`
  + String.raw`|(?:(?:Output|Input)${SEP})?${TAX_WORD}(?![A-Za-z])`
  + String.raw`|${PAYABLE_LABEL}`
  + String.raw`|(?:${NET_PREFIX}${SEP})?(?:${EXCL}|${INCL})${SEP}${TAX_WORD}(?![A-Za-z])`
  + String.raw`|${NET_PREFIX}${SEP}${EXCL_LONG}(?![A-Za-z])`
  + String.raw`)`,
  'i',
);
