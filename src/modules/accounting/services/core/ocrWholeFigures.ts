/**
 * Numbers a document prints WITHOUT cents, what marks one as money, and the
 * few EXACT shapes and labels that say a number is not money.
 *
 * ONE reader for all three rules of the whitelist: every whole number on
 * every line. It does not decide that a number is money — the roles that do
 * (a payment, a change, a summary line) belong to `ocrPrintedFigures`. What it
 * owns is the other direction, and every rule here has to answer one question
 * before it may exist: CAN THIS EXEMPTION EVER LET MONEY THROUGH? Round 19
 * had three that could — a counter word matched at the END of a label (`Tip for
 * Server 23`, `Levy per Unit 350`), a reference-code shape that swallowed
 * `TIP-23` and `EFT-1500`, and `of`/unit/street/mask shapes that dropped `fee
 * of 350`, `Corkage 50 pp` and `Paid 253 One Way`. So each is now EXACT:
 *
 *  - a counter label must BE the whole label, anchored at the line start or
 *    the previous figure (`counterLabel`) — a label that merely ends in a
 *    counter word is money — and a bare COUNT noun only nominates its number:
 *    the whole-document reader decides (see `COUNT_NOUN`);
 *  - `of` exempts only `N of M`; a masked card only `****` then exactly four
 *    digits; a street number only at the start of its line;
 *  - a unit exempts a number only when no role claims it: a DURATION (`30
 *    days`) only after a terms or prose lead (`within`, `Terms:`) and only up
 *    to two digits; a MEASURE
 *    (`150 km`, `23 x`) only in a row that prices it in cents — `Travel 150
 *    km` alone is the charge; and `pp`, a price per person, is never a unit;
 *  - a reference code (`TAL-998877`) is exempt only behind a counter label.
 *
 * Leader fillers (`Call-out fee........350.00`) are blanked before anything is
 * read, so a figure glued to its dots is still a figure (round-19 HIGH-3).
 */
import { parseAmount } from './ocrAmountParsing';

/** A whole number found on a line, before any role is given to it. */
export interface WholeToken {
  value: number;
  index: number;
  end: number;
  /** An `R`/`ZAR` in front, or `ZAR`, `,-`, `.-`, `=` or a dash after it. */
  moneyMark: boolean;
  /** A duration follows it after a terms lead (`within 30 days`): not money unless a role claims it. */
  timeAfter: boolean;
  /** A measure follows it (`150 km`): not money only in a priced row, unless a role claims it. */
  unitAfter: boolean;
}

const WHOLE = /(?<![A-Za-z\d.,])((?:R|ZAR)\s?:?\s?)?(\d{1,3}(?:[ \u00A0.,]\d{3})+(?!\d)|\d+)(?![\d])(?![.,]\d)/g;

const MONEY_SUFFIX = /^\s*(?:ZAR(?![A-Za-z])|,-|\.-|=|-(?!\d))/i;
/**
 * A DURATION exempts its number only after a TERMS or prose lead (`within 30
 * days`, `Open 7 days`, `Payment terms: 30 days`). Round 20 exempted it
 * anywhere on the claim that a duration is never a rand amount; a RATE is one
 * (`Hire 450 day`, `Rent 1500 month`, `Labour 450 hr`), and it posted.
 */
const DURATION_LEAD = /(?<![A-Za-z])(?:within|in|for|after|every|open|valid(?:ity)?(?:\s+for)?|terms|net|due\s+in|payable\s+within|binne|oor|elke|oop|termyn|period)\s*:?\s*$/i;
const TIME_UNIT = /^\s+(?:days?|dae|nights?|nagte?|weeks?|weke|months?|maande|years?|jaar|hrs?|hours?|uur|mins?|minutes?)(?![A-Za-z])/i;
/** A MEASURE: a quantity only in a priced row (`Travel 150 km 450.00`); alone it may be the charge. */
const MEASURE_UNIT = /^\s+(?:km|kms|m|cm|mm|kg|kgs|g|grams?|l|lt|litres?|liters?|ml|pcs|pieces?|units?|items?|x)(?![A-Za-z])/i;
/**
 * A MEASUREMENT: the label names a dimension and the unit is that dimension's
 * (`Weight 5 kg`, `Distance 12 km`). Money beside it (`Weight 350 kg`) is still
 * a weight — a charge is never written that way — so it is exempt anywhere.
 * `Travel 150 km` has no dimension label, and stays a charge.
 */
const MEASUREMENT = [
  [/(?<![A-Za-z])(?:Weight|Mass|Gewig|Massa)\s*:?\s*$/i, /^\s+(?:kg|kgs|g|grams?|t|tons?)(?![A-Za-z])/i],
  [/(?<![A-Za-z])(?:Distance|Afstand)\s*:?\s*$/i, /^\s+(?:km|kms|m)(?![A-Za-z])/i],
  [/(?<![A-Za-z])(?:Volume)\s*:?\s*$/i, /^\s+(?:l|lt|litres?|liters?|ml)(?![A-Za-z])/i],
] as const;
const GLUED_UNIT = /^(?:L|ML|G|KG|MG|M|CM|MM|KM|S|PC|PCS|PK|PKT|GB|MB|TB|MBPS|W|KW|V|H|HRS|MIN)(?![A-Za-z])/i;
const STREET = /^\s+(?:[A-Z][A-Za-z]+\s+){1,3}(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Lane|Ln|Crescent|Cres|Close|Way|Boulevard|Blvd|Weg|Straat|Laan|Rylaan)(?![A-Za-z])/;

/**
 * Blank the fillers between a label and its figure — a run of dots, dashes,
 * underscores, tildes or middots before a figure — and phone numbers, so both
 * readers see `Call-out fee        350.00`. Lengths are kept, so every index
 * into the line still points where it did.
 */
export function blankFillers(line: string): string {
  const blank = (m: string) => ' '.repeat(m.length);
  return line
    .replace(/[._~·…-]{2,}(?=\s*(?:R|ZAR)?\s*\d)/g, blank)
    .replace(/(?<!\d)(?:\+27|0)\d{2}[ -]\d{3}[ -]\d{4}(?!\d)/g, blank);
}

/**
 * Nouns whose bare number MAY be a count or a device id (`Items 3`, `Table
 * 12`, `Till 4`, `Covers 2`). Round 22 stopped trusting the noun: 170 of 174
 * bare `noun 350` probes posted, because every noun here also names money on
 * some document (`Operator 800` on a plant-hire invoice). So the noun alone
 * exempts nothing — it only makes the number a CANDIDATE count, and the reader
 * of the whole document (`unreconciledFigure`) decides by structure: a count
 * only on a document PAID IN FULL, and only while the number is small. A noun
 * missing here costs a refusal, never a post.
 */
const COUNT_NOUN = String.raw`(?:Items?|Qty|Quantity|Units?|Pieces|Parcels?|Packages?|Boxes|Cartons?|Lane|Class|Till|Til|Pump|Table|Tafel|Cashier|Kassier|Operator|Op|Clerk|Page|Bladsy|Batch|Seq(?:uence)?|Store|Shop|Branch|Terminal|Trans(?:action)?|Auth(?:ori[sz]ation)?\s*Code|Approval\s*Code|Seats?|Guests?|Pax|Covers|Points\s+(?:Earned|Balance)|(?:Smart\s*Shopper|Club\s*Card|W?Rewards|eBucks|Vitality|Benefit)\s+Points|Odometer|Floor|Aisle|Serial|Version)`;
/**
 * Nouns whose number is a REFERENCE only when the label says so — a number
 * word (`Order No 45`, `Receipt #1234`) or a long code (`Waybill: TCG-998877`).
 * Bare, they are money at any size (`Receipt 1500`, `Order 35`, `Server 23`).
 */
const REFERENCE_NOUN = String.raw`(?:Receipt|Slip|Invoice|Order|Ref(?:erence)?|Acc(?:ount)?|Code|Room|Server|Copy|Register|Lot|Waybill)`;
const COUNTER_LEAD = String.raw`(?:Your|Customer|Visit\s+us\s+at|Smart\s*Shopper|Club\s*Card|W?Rewards?|Benefit|Vitality|eBucks|No\.?\s+of|Total|Delivery|Tax|VAT)`;
const NUMBER_WORD = String.raw`(?:\s*(?:No|Nr|Number|#)\.?)`;
const CODE_PREFIX = String.raw`(?:[A-Z]{1,4}[-/])`;
const COUNT_HEAD = String.raw`(?:${COUNTER_LEAD}\s+)?${COUNT_NOUN}(?:\s+(?:Sold|Earned|Copy))?`;

/**
 * A REFERENCE: the label says the number is an id — a number word or a long
 * code after a listed noun, or a bare `No`/`#` label. Exempt at any size,
 * because a number word is a shape a charge is never printed in.
 */
const REFERENCE_LABEL = new RegExp(
  String.raw`^[\s:#.=,*-]*(?:`
  + String.raw`(?:${COUNT_HEAD}|(?:${COUNTER_LEAD}\s+)?${REFERENCE_NOUN})(?:${NUMBER_WORD}[\s:#.=-]*${CODE_PREFIX}?|[\s:#.=-]*${CODE_PREFIX})`
  + String.raw`|(?:No|Nr|#)\.?[\s:#.=-]*${CODE_PREFIX}?`
  + String.raw`)[\s:#.=-]*$`,
  'i',
);
/** A bare COUNT: a count noun and nothing else — a candidate only (see `COUNT_NOUN`). */
const COUNT_LABEL = new RegExp(String.raw`^[\s:#.=,*-]*${COUNT_HEAD}[\s:.=-]*$`, 'i');
/**
 * A bank BRANCH CODE: six digits after `Branch`/`Br` (`Branch Code: 250655`).
 * Six digits is at least R100 000, so it can only hide a figure larger than
 * the total — and no document prints its six-figure payable as a branch code.
 */
const BRANCH_CODE = /(?<![A-Za-z])(?:Branch|Br)\.?(?:\s+(?:Code|No\.?))?[\s:#.=-]*$/i;
/** A year after "since"/"est." — `Est. 1967`, `…with us since 1967`. */
const YEAR_LABEL = /(?<![A-Za-z])(?:since|sedert|est\.?|established)\s*$/i;

/**
 * What the WHOLE label says the number is. `segment` is the text from the line
 * start (or the previous figure) to the number. The noun must open it — after
 * at most one fixed leading word (`Customer copy`, `Total Items`) — so `Admin
 * fee per Invoice` names nothing. `'reference'` is never money; `'count'` is a
 * candidate that only a document paid in full may keep; null is money.
 */
export function counterLabel(segment: string, value: number): 'reference' | 'count' | null {
  // The label starts after the last digit in front of it: a reference or a
  // zero-led id this reader skipped (`Acc 62012345678 Branch`, `Till 04
  // Cashier`) is still the previous figure.
  const label = segment.replace(/^[^]*\d/, '');
  // A code prefix makes a reference only on a long number (`TAL-998877`):
  // `Ref: TIP-350` and `Receipt No: CASH-1500` are a tip and a payment.
  if (new RegExp(`${CODE_PREFIX}[\\s]*$`).test(label) && value < 10000) return null;
  if (REFERENCE_LABEL.test(label)) return 'reference';
  if (BRANCH_CODE.test(label) && value >= 100000 && value <= 999999) return 'reference';
  if (COUNT_LABEL.test(label)) return 'count';
  return value >= 1900 && value <= 2099 && YEAR_LABEL.test(label) ? 'reference' : null;
}

/**
 * Every whole number on `line` (already through `blankFillers`). `centsSpans`
 * are the cents figures read on it, blanked first so no digit is read twice.
 */
export function wholeTokens(line: string, centsSpans: ReadonlyArray<readonly [number, number]>): WholeToken[] {
  let blanked = line;
  for (const [from, to] of centsSpans) {
    blanked = blanked.slice(0, from) + ' '.repeat(to - from) + blanked.slice(to);
  }
  const tokens: WholeToken[] = [];
  for (const match of blanked.matchAll(WHOLE)) {
    const prefix = match[1];
    const digits = match[2]!;
    const start = match.index + (prefix?.length ?? 0);
    const end = match.index + match[0].length;
    const before = blanked.slice(0, start);
    const after = blanked.slice(end);
    if (/^0\d/.test(digits)) continue;
    if (!prefix && /\d\s?[:/.-]$/.test(before)) continue;
    if (/^[:/.-]\d/.test(after) || /^\s*%/.test(after)) continue;
    if (/^\s+of\s+\d/i.test(after) || /\d\s+of\s+$/i.test(before)) continue;
    if (!prefix && /[*xX]{4,}[ \t]*$/.test(before) && /^\d{4}$/.test(digits)) continue;
    if (!prefix && before.trim() === '' && STREET.test(after)) continue;
    const moneySuffix = MONEY_SUFFIX.test(after);
    const moneyMark = Boolean(prefix) || moneySuffix;
    const bare = digits.replace(/[ \u00A0.,]/g, '');
    // Seven or more digits is a VAT, account or registration number whatever
    // labels it — `VAT-4123456789` sits on a line that opens with `VAT`.
    if (bare.length >= 7 && !moneyMark) continue;
    // A measure glued to its digits (`2L`, `700G`, `3S`, `9h`) is one token — a
    // size or a model, never a separate number, whatever labels it. A WORD
    // glued on (`253APPROVED`) is not in the list, so its label decides.
    if (!prefix && GLUED_UNIT.test(after)) continue;
    // Two digits at most: a term is `30 days`, and `Storage for 350 days` or
    // `Rental period 1500 month` beside the labour is a charge (round 22).
    const timeAfter = !moneyMark && bare.length <= 2 && TIME_UNIT.test(after) && DURATION_LEAD.test(before);
    if (!moneyMark && MEASUREMENT.some(([label, unit]) => label.test(before) && unit.test(after))) continue;
    const unitAfter = !moneyMark && MEASURE_UNIT.test(after);
    tokens.push({ value: parseAmount(bare), index: start, end, moneyMark, timeAfter, unitAfter });
  }
  return tokens;
}
