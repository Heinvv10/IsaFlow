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
const OCR_LOOKALIKE: Record<string, string> = { O: '[O0]', I: '[I1l]', L: '[L1I]', S: '[S5]' };

function ocrTolerant(word: string): string {
  return [...word].map((c) => OCR_LOOKALIKE[c] ?? c).join('');
}

/**
 * Words that mean the document returns money rather than spends it. English
 * and Afrikaans, with the inflections each language prints. `CREDITOR` is
 * deliberately absent — a supplier statement heading is not a credit note.
 */
const CREDIT_WORDS = [
  'CREDIT', 'CREDITS', 'CREDITED', 'CREDITNOTE',
  'KREDIET', 'KREDIETNOTA', 'KREDIETNOTAS',
  'REFUND', 'REFUNDS', 'REFUNDED', 'REFUNDING',
  'TERUGBETAAL', 'TERUGBETALING', 'TERUGBETALINGS', 'TERUGGEBETAAL',
  'RETURN', 'RETURNS', 'RETURNED', 'RETOER', 'RETOERE',
  'VOID', 'VOIDED',
  'REVERSAL', 'REVERSED', 'REVERSING',
  'RETOUR', 'RETOURE',
  'CANCELLED', 'CANCELED', 'CANCELLATION', 'KANSELLASIE', 'KANSELLEER',
  'EXCHANGE', 'EXCHANGED',
];

/**
 * The ABBREVIATIONS the same document types are printed under. Round 15's
 * word list was beaten by thirteen of them on the first attempt: `CR NOTE
 * 0012`, `Cr Note No 0012`, `C/N 0012`, `CRN 0012`, `CR/NOTE`, `RETOUR`,
 * `TAX INVOICE (CR)`, `CANX`, `CANX SALE`, `RTN SLIP`, `R/A 0012`.
 *
 * This set IS closed where the charge names were not, and the difference is
 * where each set comes from. A charge is a noun a merchant invents — `Car
 * Guard`, `Packer`, `Tronc`, `Bag Levy` — and the next merchant invents
 * another. An abbreviation is a CONTRACTION of a word already above: the
 * document types that return money are credit note, return, cancellation,
 * reversal and refund, and a contraction is built from those same letters. So
 * the generator is bounded, which is why this list can be finished and the
 * charge list could not. `DEBIT NOTE` is included even though a supplier's
 * debit note ADDS to what is owed: whose debit note it is decides the
 * direction, the document does not say, and a refusal is the cheap half.
 */
const CREDIT_ABBREVIATIONS = [
  String.raw`CR[\s./-]*N(?:OTE)?`,
  String.raw`C[./-]N`,
  String.raw`CRN`,
  String.raw`RTN`,
  String.raw`CANX`,
  String.raw`R[./]A`,
  String.raw`ADJUSTMENT\s+N[O0]TE`,
  String.raw`DEB[I1l]T\s+N[O0]TE`,
];

const CREDIT_WORD = new RegExp(
  `(?<![A-Za-z0-9])(?:${[...CREDIT_WORDS.map(ocrTolerant), ...CREDIT_ABBREVIATIONS].join('|')})(?![A-Za-z0-9])`,
  'i',
);

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
    if (/^-(?!\d)/.test(after) || /[-–](?:R|ZAR)?$/.test(before)) return true;
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
  return total !== null && total !== undefined && total !== 0 && totalPrintedSigned(text, total);
}
