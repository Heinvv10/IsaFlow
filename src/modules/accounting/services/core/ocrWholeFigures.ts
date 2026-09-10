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
 *    the previous figure (`isCounterLabel`) — a label that merely ends in a
 *    counter word is money;
 *  - `of` exempts only `N of M`; a masked card only `****` then exactly four
 *    digits; a street number only at the start of its line;
 *  - a unit exempts a number only when no role claims it: a DURATION (`30
 *    days`) only after a terms or prose lead (`within`, `Terms:`); a MEASURE
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
 * Nouns whose number is a COUNT or a device/batch id — a number after them
 * cannot be a rand amount. Every entry was checked the other way round before
 * it stayed: the probe that puts money beside it (`Pump 350`, `Batch 350`,
 * `Terminal 1500`) is a pump, a batch and a terminal, not a charge. Round 20
 * added twelve nouns without that check — `Mileage`, `Warranty`, `Quote`,
 * `Ticket`, `Job`… — and every one of them names money on an ordinary invoice
 * (`Mileage 350` posted R1 150 against R1 500). They are gone.
 */
const COUNT_NOUN = String.raw`(?:Items?|Qty|Quantity|Units?|Pieces|Parcels?|Packages?|Boxes|Cartons?|Lane|Class|Till|Til|Pump|Table|Tafel|Cashier|Kassier|Operator|Op|Clerk|Page|Bladsy|Batch|Seq(?:uence)?|Store|Shop|Branch|Terminal|Trans(?:action)?|Auth(?:ori[sz]ation)?\s*Code|Approval\s*Code|Seats?|Guests?|Pax|Points\s+(?:Earned|Balance)|(?:Smart\s*Shopper|Club\s*Card|W?Rewards|eBucks|Vitality|Benefit)\s+Points|Odometer|Floor|Aisle|Serial|Version)`;
/**
 * Nouns that can ALSO name money (`Receipt 1500`, `Account 1500`, `Room 350`,
 * `Order 35`, `Server 23`, `Covers 50`, `Code 23`, `Customer Copy 23`): their
 * number is a reference only when the label says so — a number word (`No`,
 * `Nr`, `#`) or a code prefix (`Waybill: TCG-998877`). A bare number after them
 * is money. `Address` and a generic `Points` are gone for the same reason
 * (`Delivery Address 35`, `Loyalty Points 23`); points EARNED, a points
 * BALANCE and a NAMED programme's points (`ClubCard points 13`) stay a count.
 */
const REFERENCE_NOUN = String.raw`(?:Receipt|Slip|Invoice|Order|Ref(?:erence)?|Acc(?:ount)?|Code|Room|Server|Covers|Copy|Register|Lot|Waybill)`;
const COUNTER_LEAD = String.raw`(?:Your|Customer|Visit\s+us\s+at|Smart\s*Shopper|Club\s*Card|W?Rewards?|Benefit|Vitality|eBucks|No\.?\s+of|Total|Delivery|Tax|VAT)`;
const NUMBER_WORD = String.raw`(?:\s*(?:No|Nr|Number|#)\.?)`;
const CODE_PREFIX = String.raw`(?:[A-Z]{1,4}[-/])`;

/**
 * Is this the WHOLE label of a count or a reference? `segment` is the text
 * from the line start (or the previous figure) to the number. The noun must
 * open it — after at most one fixed leading word (`Customer copy`, `Total
 * Items`) — and nothing but a number word and a code prefix may follow it.
 * `Admin fee per Invoice` does not open with one.
 */
const COUNTER_LABEL = new RegExp(
  String.raw`^[\s:#.=,*-]*(?:`
  + String.raw`(?:${COUNTER_LEAD}\s+)?${COUNT_NOUN}(?:\s+(?:Sold|Earned|Copy))?${NUMBER_WORD}?[\s:#.=-]*${CODE_PREFIX}?`
  + String.raw`|(?:${COUNTER_LEAD}\s+)?${REFERENCE_NOUN}(?:${NUMBER_WORD}[\s:#.=-]*${CODE_PREFIX}?|[\s:#.=-]*${CODE_PREFIX})`
  + String.raw`|(?:No|Nr|#)\.?[\s:#.=-]*${CODE_PREFIX}?`
  + String.raw`)[\s:#.=-]*$`,
  'i',
);
/** A year after "since"/"est." — `Est. 1967`, `…with us since 1967`. */
const YEAR_LABEL = /(?<![A-Za-z])(?:since|sedert|est\.?|established)\s*$/i;

export function isCounterLabel(segment: string, value: number): boolean {
  // The label starts after the last digit in front of it: a reference or a
  // zero-led id this reader skipped (`Acc 62012345678 Branch`, `Till 04
  // Cashier`) is still the previous figure.
  const label = segment.replace(/^[^]*\d/, '');
  // A code prefix makes a reference only on a long number (`TAL-998877`):
  // `Ref: TIP-350` and `Receipt No: CASH-1500` are a tip and a payment.
  if (new RegExp(`${CODE_PREFIX}[\\s]*$`).test(label) && value < 10000) return false;
  if (COUNTER_LABEL.test(label)) return true;
  return value >= 1900 && value <= 2099 && YEAR_LABEL.test(label);
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
    const timeAfter = !moneyMark && TIME_UNIT.test(after) && DURATION_LEAD.test(before);
    if (!moneyMark && MEASUREMENT.some(([label, unit]) => label.test(before) && unit.test(after))) continue;
    const unitAfter = !moneyMark && MEASURE_UNIT.test(after);
    tokens.push({ value: parseAmount(bare), index: start, end, moneyMark, timeAfter, unitAfter });
  }
  return tokens;
}
