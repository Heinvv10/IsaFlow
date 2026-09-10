/**
 * Does the document's TEXT say it is a credit, a refund, a return, a void or a
 * reversal?
 *
 * Every posting path the unattended gate serves books a PURCHASE, so a
 * document that returns money posts the entry backwards: the expense, the
 * input VAT and the bank leg all move the wrong way, and nobody sees it.
 *
 * Rounds 12 to 14 anchored each indicator to a position where it could only
 * describe the DOCUMENT — a header alone on its line, a refund word sharing a
 * line with a money figure — so that `Credit card surcharge 5.00` stayed an
 * ordinary purchase. Every one of those anchors was beaten on the first
 * attempt by a slip a South African business prints every day: `REFUND SLIP
 * 0012` and `KREDIETNOTA Nr KN00123` print the document number BESIDE the
 * word, so the line is not the header alone and carries no cents; `VOID`,
 * `REVERSAL`, `CANCELLED SALE` and `GOODS RETURNED` were not in the
 * vocabulary at all; `CRED1T NOTE` is what the scanner made of it.
 *
 * So the rule is no longer a position. It is the COST ASYMMETRY: a refusal
 * costs a person a few seconds on the capture screen, and a wrong-direction
 * post moves money silently. A credit word ANYWHERE in the document, as a
 * whole word, case-insensitive, Afrikaans included and tolerant of the
 * substitutions a scanner makes (0/O, 1/I/l, 5/S), refuses.
 *
 * That over-refuses on ordinary documents, and the carve-back is an explicit
 * list of benign PHRASES — never a bare word, because a bare word is the
 * anchor that failed. Each phrase below was measured on the ordinary corpus
 * before it was added. A phrase is scrubbed out of the text and the words are
 * then looked for in what is left, so `Credit card surcharge 5.00` and
 * `Less credit note CN001 applied 0.00` say nothing about the document.
 */

import { parseAmount } from './ocrAmountParsing';

/**
 * The substitutions a scanner makes on printed capitals. Applied MECHANICALLY
 * to each word below, so no one has to hand-spell `CRED[I1l]T` and get one of
 * them wrong — which is how `TERUGBETAL` came to miss `terugbetaal`.
 */
const OCR_LOOKALIKE: Record<string, string> = {
  O: '[O0]', I: '[I1l]', L: '[L1I]', S: '[S5]', N: '[NH]', H: '[HN]',
};

function ocrTolerant(word: string): string {
  return [...word].map((c) => OCR_LOOKALIKE[c] ?? c).join('');
}

/**
 * The STEMS of the words that mean the document returns money rather than
 * spends it, English and Afrikaans. Each matches every inflection by prefix —
 * `OMRUIL` reads `OMRUILING`, `TERUGBETA` reads `TERUGBETAAL`, `TERUGBETALING`
 * and `TERUGBETAALDE`, `KREDIT` reads `KREDITNOTA` — because round 17 matched
 * whole words and the review posted `OMRUILING` and `TERUGBETAALDE` for want of
 * a listed form. No stem may be followed by `OR`: `CREDITOR` heads a supplier
 * statement, which is not a credit note. `REVERS` takes its three verb forms
 * only, since `REVERSE` is also "see reverse" and the reverse-charge VAT line.
 */
const CREDIT_STEMS = [
  'CREDIT', 'KREDIET', 'REFUND', 'REIMBURS', 'RETURN', 'RETOER', 'RETOUR', 'VOID', 'CANCEL', 'ANNUL',
  'EXCHANG', 'KORREKSIE', 'STORNO', 'GUTSCHRIFT', 'AVOIR', 'RÜCKGABE', 'RUCKGABE', 'MINUS',
];

/**
 * Afrikaans VERBS, as `[particle, stem]`, because an Afrikaans past participle
 * does not start with its stem and no prefix can reach it: `GE-` goes in front
 * (`KANSELLEER` → `GEKANSELLEER`, `KREDITEER` → `GEKREDITEER`) or, on a
 * separable verb, after the particle (`OMRUIL` → `OMGERUIL`, `TERUGGEE` →
 * `TERUGGEGEE`). Each is generated with and without the `GE`, so the
 * participle is a rule and not another row somebody has to remember.
 */
const AFRIKAANS_VERBS: ReadonlyArray<readonly [string, string]> = [
  ['', 'KANSELL'], ['', 'KREDIT'], ['', 'ANNULEER'], ['', 'KORRIGEER'], ['', 'RETOURNEER'],
  ['OM', 'RUIL'], ['UIT', 'RUIL'], ['TERUG', 'BETA'], ['TERUG', 'GEBETAAL'], ['TERUG', 'GAWE'],
  ['TERUG', 'GEE'], ['TERUG', 'STUUR'],
];
const AFRIKAANS_FORMS = AFRIKAANS_VERBS.flatMap(([particle, stem]) => [
  `${particle}${stem}`, `${particle}GE${stem}`,
]);

const CREDIT_WORDS = [
  ...[...CREDIT_STEMS, ...AFRIKAANS_FORMS].map((stem) => `${ocrTolerant(stem)}(?![O0]R)\\w*`),
  `${ocrTolerant('REVERS')}(?:AL|ED|ING)`,
];

/**
 * The MARKINGS and abbreviations the same document types are printed under.
 *
 * Round 16 claimed this set was "closed", on the argument that an abbreviation
 * contracts a word already listed while a charge name is invented. **That
 * claim was false and is withdrawn.** The round-16 review posted 20 of 36
 * markings: bare `CR` (how Sage and Pastel, the systems most SA suppliers run,
 * mark a credit — `TOTAL 499.00 CR`), `CN`, `KN`, the Afrikaans `OMRUIL`,
 * `TERUGGAWE`, `TERUGSTUUR`, `GOEDERE TERUG` and `KORREKSIE`, and the English
 * `ALLOWANCE NOTE`, `REBATE`, `CLAIM NOTE`, `CORRECTION SLIP`, `NEGATIVE
 * SALE`, `MINUS SALE`, `NO SALE`. Half of those are not contractions of
 * anything; they are simply more words, and the word list under the
 * abbreviations is the same open set it always was.
 *
 * What holds the line is not this list — it is that a credit word ANYWHERE
 * refuses and the carve-back is by phrase, so a spelling missing here costs a
 * wrong-direction post only when NOTHING else on the document is off. Adding a
 * marking is cheap; relying on the list being complete is what was wrong.
 *
 * A space means an OPTIONAL separator (`CR NOTE` also reads `CRNOTE`,
 * `CR/NOTE`, `CR-NOTE`), a `/` a REQUIRED one (`R/A` must not read `RA`), and
 * every letter goes through `ocrTolerant` — round 16 concatenated these RAW,
 * so `CR N0TE 0012` escaped while `CRED1T N0TE` refused, which is the exact
 * hand-spelling failure the mechanical map exists to prevent.
 */
const CREDIT_MARKINGS = [
  'CR NOTE', 'CRD NOTE', 'CRED NOTE', 'KRED NOTA', 'KR NOTA', 'CRN', 'C N', 'K N', 'C R', 'CR', 'C/M',
  'RTN', 'RTRN', 'RTV', 'RETD', 'RFND', 'RFD', 'REFD', 'RVSL', 'REVSL', 'RMA', 'CANX', 'CANC', 'CNCL',
  'CXL', 'CNX', 'R/A', 'REVERSE SALE', 'NEG SALE', 'VE SALE', 'RET D', 'ADJ NOTE', 'MONEY BACK', 'KANS',
  'ADJUSTMENT NOTE', 'DEBIT NOTE', 'ALLOWANCE NOTE', 'REBATE NOTE', 'REBATE',
  'CLAIM NOTE', 'CORRECTION SLIP', 'NEGATIVE SALE', 'MINUS SALE', 'NO SALE',
  'GOEDERE TERUG',
];

const SEPARATOR = String.raw`[\s./'-]`;

/** `CR NOTE` → `CR[\s./-]*N[O0]TE`; `R/A` → `R[\s./-]A`. */
function ocrTolerantMarking(marking: string): string {
  const chars = (word: string) => [...word].map((c) => OCR_LOOKALIKE[c] ?? c).join('');
  return marking.split(' ')
    .map((word) => word.split('/').map(chars).join(SEPARATOR))
    .join(`${SEPARATOR}*`);
}

const CREDIT_WORD = new RegExp(
  `(?<![A-Za-z0-9])(?:${[...CREDIT_WORDS, ...CREDIT_MARKINGS.map(ocrTolerantMarking)].join('|')})(?![A-Za-z0-9])`,
  'i',
);

/**
 * The Sage/Pastel `CR` printed against its figure, with or without the space
 * OCR so often drops, in any case: `TOTAL 499.00CR`, `R499.00 cr.`, and its
 * Afrikaans twin `TOTAL 499.00 KT` (kt, krediet). The lookbehind above refuses
 * a marking glued to a digit, which is right for words and wrong for this mark.
 */
const AMOUNT_CR = /\d\s*(?:CR|KT)\.?(?![A-Za-z0-9])/i;

/**
 * A credit memo, reversal, return or return authorisation NUMBERED: `CM 0012`,
 * `REV 0012`, `RET 0012`, `RA 0012`. Bare, the first two are
 * everyday words on a purchase (`Ruler 30 CM 115.00`, `Rev B`), so they count
 * only where a number follows AND none precedes on the line — a length is the
 * number before it, and the price after it is not a document number.
 */
const NUMBERED_MARKING = /(?<![A-Za-z0-9])(?<!\d[ \t]*)(?:CM|REV|RET|RA|VD|GRV)[\s#:.-]*\d/i;

/**
 * A Pastel credit-note NUMBER glued to its prefix: `CRN00045`, `CN0012`,
 * `KN00123`. The word wrapper refuses a marking followed by a digit, so
 * `CRN-00045` refused while the glued form posted.
 */
const GLUED_CREDIT_NUMBER = /(?<![A-Za-z0-9])(?:CRN|CN|KN)\d/i;

/** `TAX INVOICE (CR)` — the marker printed in brackets beside the type. */
const BRACKETED_CREDIT = /\(\s*CR\s*\)/i;

/**
 * Phrases in which a credit word describes something OTHER than this
 * document: a payment method, a trading term, a shop's policy, or a credit
 * note that was applied to a purchase rather than being one. Each is a
 * PHRASE — two words at least — because every bare-word carve-out attempted
 * on this item was also the spelling of a real credit document.
 *
 * Two are line-shaped: a bare `RETURNS` heading is benign only when the line
 * under it is the shop's policy, and `Less credit note … applied` is an AP
 * invoice deducting a credit it is not. The heading is FIRST because the
 * phrases are scrubbed in order and the policy sentence its lookahead reads
 * would otherwise already be blank.
 */
const BENIGN_PHRASES: RegExp[] = [
  /^[\s*=-]*returns?[\s*=-]*$(?=\n[^\n]*\b(?:return|refund|exchange|goods|days|slip)\w*\b)/gim,
  /(?:credit|debit)\s*[-/]?\s*card/gi,
  /(?:visa|master(?:\s*card)?|amex|american\s+express|diners|maestro)\s+credit/gi,
  /krediet\s*kaart/gi,
  /credit\s+(?:limit|application|controller|terms|account|balance)/gi,
  /acc(?:ount)?\.?\s*type\s*:?\s*(?:credit|debit)/gi,
  // ON ONE LINE. `[\s./-]` would cross the newline in `TOTAL 499.00 CR\nCARD
  // 499.00` and scrub the Pastel credit marking this phrase exists beside.
  // …and never on a `CR` that follows a FIGURE on the same line: in `TOTAL
  // 499.00 CR  CARD 499.00` the CR is the Pastel credit mark, not a card type.
  /(?<!\d[ \t]*)(?:cr|dr)[ \t./-]*card/gi,
  /card[ \t./-]*(?:cr|dr)(?![A-Za-z0-9])/gi,
  /on\s+credit(?![A-Za-z])/gi,
  /(?:no|geen)\s+(?:cash\s+)?(?:refunds?|returns?|exchanges?|terugbetalings?)[^\n]*/gi,
  /(?:refunds?|returns?|exchanges?)\s+(?:policy|within|only|accepted|will|are|is|subject|may|must)[^\n]*/gi,
  /(?:goods|items?)\s+(?:returned|exchanged)\s+(?:must|may|can|will|should|are|is|within|in)\b[^\n]*/gi,
  /(?:may|can|will|must|shall)\s+(?:not\s+)?be\s+(?:returned|exchanged|refunded)[^\n]*/gi,
  /goods\s+may\s+be\s+(?:returned|exchanged)[^\n]*/gi,
  /retain\s+(?:this|your)\s+(?:slip|receipt|invoice)[^\n]*/gi,
  /returns?\s+to\s+(?:any|the|your)\s+(?:store|branch|shop)[^\n]*/gi,
  /void\s+if\s+\w+/gi,
  /cancellation\s+fee/gi,
  /credit\s+guarantee/gi,
  /(?:returned|exchanged)\s+(?:with)?in\s+\d+\s+days[^\n]*/gi,
  /exchange\s+rate[^\n]*/gi,
  /less\s+credit\s+note[^\n]*/gi,
  /money[\s-]*back\s+guarantee[^\n]*/gi,
];

/** The document with every benign phrase blanked out. */
function scrubBenign(text: string): string {
  return BENIGN_PHRASES.reduce((t, phrase) => t.replace(phrase, (m) => ' '.repeat(m.length)), text);
}

/** A money figure; what is printed immediately around it carries the sign. */
const FIGURE = /(?<![\d.,])(\d{1,3}(?:[ \u00A0.,]\d{3})+[.,]\d{2}|\d+[.,]\d{2})(?![\d.,]*\d)/g;

/**
 * Is a figure of the total's size printed negative — a trailing minus, a
 * minus glued to it, or parentheses? A SPACED dash (`Total - 115.00`) is a
 * label separator, as `VALUE_SEP` reads it, and is not a sign.
 */
function totalPrintedSigned(text: string, total: number): boolean {
  const size = Math.abs(total);
  for (const match of text.matchAll(FIGURE)) {
    if (parseAmount(match[1]!) !== size) continue;
    const before = text.slice(Math.max(0, match.index - 6), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 3);
    // `-R 499.00`: the minus is glued to the currency mark, not to the space
    // after it — a spaced dash alone (`Total - 115.00`) is still a separator.
    if (/^-(?!\d)/.test(after) || /[-–](?:(?:R|ZAR)\s?)?$/.test(before)) return true;
    if (/\(\s*(?:R|ZAR)?\s*$/.test(before) && /^\s*\)/.test(after)) return true;
  }
  return false;
}

/**
 * Who the document is FROM is not what the document is.
 *
 * `Credit Solutions SA`, `Refund Recovery Services` and `Shop 5, The Exchange,
 * Sandton` are a supplier's name and address, and round 15 read all three as
 * credit notes. This is the structural carve-back the phrase list cannot be:
 * the extracted vendor identity is blanked out of the text before the words
 * are looked for, so a credit word inside it says nothing about the document,
 * while a `CREDIT NOTE` header printed by that same supplier still refuses.
 */
function scrubVendorIdentity(text: string, identity: readonly (string | null | undefined)[]): string {
  return identity.reduce<string>((acc, part) => {
    const trimmed = (part ?? '').trim();
    if (trimmed.length < 3) return acc;
    return acc.split(trimmed).join(' '.repeat(trimmed.length));
  }, text);
}

export function hasCreditIndicator(
  text: string,
  total: number | null | undefined,
  vendorIdentity: readonly (string | null | undefined)[] = [],
): boolean {
  const scrubbed = scrubBenign(scrubVendorIdentity(text, vendorIdentity));
  if (CREDIT_WORD.test(scrubbed) || BRACKETED_CREDIT.test(scrubbed)) return true;
  if (AMOUNT_CR.test(scrubbed) || NUMBERED_MARKING.test(scrubbed) || GLUED_CREDIT_NUMBER.test(scrubbed)) return true;
  return total !== null && total !== undefined && total !== 0 && totalPrintedSigned(text, total);
}
