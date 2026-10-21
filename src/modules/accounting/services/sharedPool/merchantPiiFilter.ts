/**
 * Shared merchant-pattern pool — the PII filter (Hein, 2026-10-21, decision 5). Pure: no imports, no I/O.
 *
 * Turns a bank-line description (or a learned pattern) into the merchant key the pool stores, or REJECTS it.
 * The aggregation job runs every candidate through this BEFORE anything is counted, and the scoped reader
 * runs the caller's description through the same function, so a key only ever exists in this shape.
 *
 * WHEN UNSURE, REJECT. A rejected line costs one cold-start suggestion; a leaked name or account number is
 * a POPIA incident. The checks, in order:
 *   1. empty / not text                                  -> 'empty'
 *   2. an e-mail address                                 -> 'contact_detail'
 *   3. a salary / wage / loan / transfer / person-payment word anywhere (SALARY, TRF, PAYMENT TO, CASHSEND…)
 *                                                        -> 'person_payment'
 *   4. an identifier BEFORE stripping (a run of 7+ digits: SA ID 13, account 7-13, phone 10, card) or a
 *      phone-number shape: kept only if a known merchant token remains; otherwise the WHOLE line is
 *      rejected, never just stripped                    -> 'identifier'
 *   5. normalise: uppercase, fold accents, drop digits, punctuation, masked-card / ref / date / location
 *      noise tokens
 *   6. no known brand, and more than MAX_WORDS words left or a word only a person writes (PLEASE, FOR, MY,
 *      BIRTHDAY…): free text                             -> 'free_text'
 *   7. a person shape: an honorific (MR, MRS, DR, ME…), a single-letter initial, or a common first name
 *      leading the line — unless a known merchant token is present (MR PRICE, MR D) -> 'person_name'
 *   8. nothing but generic banking words left (PAYMENT, EFT, DEBIT ORDER, CASH, DEPOSIT…) -> 'generic'
 *   9. key shorter than MIN_KEY_LENGTH                   -> 'too_short'
 *
 * The key is the known merchant brand when one is present (ENGEN SANDTON 1234 -> ENGEN), otherwise the
 * first KEY_WORDS words left (so a branch or suburb after the name does not fragment, or locate, a merchant).
 */

export const MERCHANT_FILTER_VERSION = 1;
export const MAX_WORDS = 6;
export const KEY_WORDS = 2;
export const MIN_KEY_LENGTH = 3;

export type MerchantRejectReason =
  | 'empty' | 'contact_detail' | 'person_payment' | 'identifier' | 'free_text' | 'person_name' | 'generic' | 'too_short';

export type MerchantFilterResult = { ok: true; merchant: string } | { ok: false; reason: MerchantRejectReason };

/**
 * Brands the pool may key on even next to an identifier, an honorific or an initial. Single tokens, after
 * normalisation (MR PRICE -> MRPRICE is matched as the pair below). Extend with care: every entry is a
 * statement that the token is a business, never a person.
 */
const KNOWN_MERCHANTS = new Set([
  // utilities, telecoms, ISPs, municipal, SARS
  'ESKOM', 'TELKOM', 'VODACOM', 'MTN', 'CELLC', 'AFRIHOST', 'WEBAFRICA', 'AXXESS', 'VUMATEL', 'OPENSERVE',
  'COOLIDEAS', 'MWEB', 'DSTV', 'MULTICHOICE', 'SHOWMAX', 'SARS', 'CITYPOWER', 'JOBURGWATER',
  // fuel
  'ENGEN', 'SHELL', 'SASOL', 'CALTEX', 'ASTRON', 'BP', 'TOTALENERGIES',
  // retail, groceries, hardware, stationery
  'CHECKERS', 'SHOPRITE', 'WOOLWORTHS', 'PICKNPAY', 'PNP', 'SPAR', 'MAKRO', 'DISCHEM', 'CLICKS',
  'BUILDERS', 'CASHBUILD', 'LEROYMERLIN', 'WATERSHED', 'TAKEALOT', 'INCREDIBLECONNECTION', 'WALTONS', 'CNA',
  'PEP', 'ACKERMANS', 'MRPRICE', 'MRD', 'BOXER', 'USAVE', 'FOODLOVERS', 'MASSMART', 'EDGARS',
  // food & travel
  'UBER', 'UBEREATS', 'BOLT', 'KFC', 'MCDONALDS', 'NANDOS', 'STEERS', 'WIMPY', 'SPUR', 'DEBONAIRS', 'VIDA',
  'MUGGBEAN', 'KAUAI', 'AIRLINK', 'FLYSAFAIR', 'SAA', 'AIRBNB', 'PROTEA', 'TSOGO', 'CITYLODGE',
  'SANRAL', 'ETOLL', 'AVIS', 'HERTZ', 'EUROPCAR', 'BIDVEST', 'TEMPEST',
  // software, advertising, couriers
  'GOOGLE', 'MICROSOFT', 'APPLE', 'ADOBE', 'ZOOM', 'DROPBOX', 'NETFLIX', 'SPOTIFY', 'AMAZON', 'AWS', 'FACEBOOK',
  'LINKEDIN', 'XERO', 'SAGE', 'CANVA', 'SLACK', 'GITHUB', 'OPENAI', 'HETZNER', 'XNEELO', 'ARUBA',
  'DHL', 'FEDEX', 'ARAMEX', 'POSTNET', 'PARGO', 'COURIERGUY', 'DAWNWING', 'FASTWAY', 'RAM', 'SKYNET',
  // banks (bank charges), insurance, security
  'FNB', 'ABSA', 'NEDBANK', 'STANDARDBANK', 'CAPITEC', 'INVESTEC', 'DISCOVERY', 'TYMEBANK', 'OUTSURANCE',
  'SANTAM', 'MOMENTUM', 'OLDMUTUAL', 'HOLLARD', 'MIWAY', 'KINGPRICE', 'ADT', 'FIDELITY', 'CHUBB',
  'YOCO', 'PAYFAST', 'OZOW', 'SNAPSCAN', 'ZAPPER',
]);

/** Two-token brands, matched before the person checks (MR PRICE would otherwise be an honorific + name). */
const KNOWN_MERCHANT_PAIRS: Record<string, string> = {
  'MR PRICE': 'MRPRICE', 'MR D': 'MRD', 'PICK N': 'PICKNPAY', 'CELL C': 'CELLC', 'STANDARD BANK': 'STANDARDBANK',
  'OLD MUTUAL': 'OLDMUTUAL', 'KING PRICE': 'KINGPRICE', 'CITY LODGE': 'CITYLODGE', 'LEROY MERLIN': 'LEROYMERLIN',
  'FOOD LOVERS': 'FOODLOVERS', 'UBER EATS': 'UBEREATS', 'CITY POWER': 'CITYPOWER', 'MUGG BEAN': 'MUGGBEAN',
  'COOL IDEAS': 'COOLIDEAS', 'COURIER GUY': 'COURIERGUY', 'E TOLL': 'ETOLL', 'TYME BANK': 'TYMEBANK',
};

/** Any of these anywhere: the line pays a person, an employee or a loan, or moves money between accounts. */
const PERSON_PAYMENT_PATTERNS: RegExp[] = [
  /\bSALAR(Y|IES)\b/, /\bWAGES?\b/, /\bPAYSLIP\b/, /\bPAY ?ROLL\b/, /\bBONUS\b/, /\bCOMMISSION\b/, /\bALLOWANCE\b/,
  /\bLOANS?\b/, /\bDRAWINGS?\b/, /\bDIVIDENDS?\b/, /\bMAINTENANCE PAYMENT\b/, /\bCHILD\b/, /\bREIMBURS/,
  /\bTRANSFER\b/, /\bTRF\b/, /\bXFER\b/, /\bINTER ?ACC/, /\bPAYMENT TO\b/, /\bPAID TO\b/, /\bPMT TO\b/,
  /\bSEND ?MONEY\b/, /\bCASH ?SEND\b/, /\bE ?WALLET\b/, /\bPAYSHAP\b/, /\bINSTANT MONEY\b/, /\bMONEY ?TRANSFER\b/,
  /\bPERSONAL\b/, /\bOWN ACC/, /\bDIRECTOR/, /\bSHAREHOLDER/, /\bSTAFF\b/, /\bEMPLOYEE/,
  /\bRENT FROM\b/, /\bDEPOSIT FROM\b/, /\bREFUND TO\b/,
];

/** Honorifics (English and Afrikaans) — a person, never a merchant (bar the KNOWN_MERCHANT_PAIRS). */
const HONORIFICS = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'ADV', 'ME', 'MEV', 'MNR', 'MEJ', 'DS', 'SIR', 'REV']);

/**
 * Common first names in South Africa (several languages). A line LEADING with one is treated as a person.
 * Not exhaustive — the residual risk (a full name with no initial, honorific or listed first name, paid by
 * MIN_DISTINCT_COMPANIES companies) is in docs/security/shared-merchant-patterns.md.
 */
const COMMON_FIRST_NAMES = new Set([
  'JOHN', 'PETER', 'DAVID', 'MICHAEL', 'JAMES', 'WILLIAM', 'RICHARD', 'ROBERT', 'PAUL', 'MARK', 'ANDREW', 'DANIEL',
  'THOMAS', 'CHRIS', 'CHRISTOPHER', 'STEPHEN', 'STEVEN', 'BRIAN', 'KEVIN', 'JASON', 'GRANT', 'CRAIG', 'SEAN',
  'MARY', 'SARAH', 'SUSAN', 'LINDA', 'KAREN', 'LISA', 'ANNA', 'ANNE', 'ELIZABETH', 'JENNIFER', 'NICOLE', 'MICHELLE',
  'JOHAN', 'JOHANNES', 'PIETER', 'JACO', 'JACQUES', 'HENDRIK', 'GERHARD', 'WILLEM', 'ANDRE', 'FRANCOIS', 'MARIUS',
  'RIAAN', 'WERNER', 'DEON', 'CORNE', 'HEIN', 'DIRK', 'KOOS', 'FANIE', 'ELSA', 'ANNELIE', 'MARIA', 'SUNETTE',
  'THABO', 'SIPHO', 'BONGANI', 'MANDLA', 'SIBUSISO', 'THEMBA', 'LUNGILE', 'NOMSA', 'THANDI', 'ZANELE', 'PALESA',
  'LERATO', 'KAGISO', 'TSHEPO', 'KABELO', 'NALEDI', 'BUSISIWE', 'NOMVULA', 'SIFISO', 'MPHO', 'TUMELO', 'KATLEGO',
  'AYANDA', 'ANDILE', 'SANDILE', 'LINDIWE', 'NTOMBI', 'PRECIOUS', 'BLESSING', 'GIFT', 'LUCKY', 'PATIENCE',
  'MOHAMMED', 'MUHAMMAD', 'AHMED', 'YUSUF', 'FATIMA', 'AISHA', 'RAJ', 'PRIYA', 'ANIL', 'SANJAY', 'DEVAN',
]);

/** Banking / card / reference noise: dropped before the key is formed. */
const NOISE_TOKENS = new Set([
  'POS', 'PURCHASE', 'PURCH', 'CARD', 'CRD', 'DEBIT', 'CREDIT', 'ORDER', 'DO', 'REF', 'REFERENCE', 'INV', 'INVOICE',
  'PMT', 'PYMT', 'PAYMENT', 'MAGTAPE', 'ACB', 'NAEDO', 'EFT', 'IB', 'APP', 'ONLINE', 'INTERNET', 'BANKING', 'CHEQUE',
  'TXN', 'TRAN', 'TRANS', 'AUTH', 'NO', 'NR', 'NUM', 'ACC', 'ACCOUNT', 'ACCT', 'XXXX', 'ZA', 'ZAF', 'RSA', 'SA',
  'PTY', 'LTD', 'CC', 'INC', 'THE', 'AND', 'OF', 'COM', 'CO', 'WWW', 'NET', 'ORG', 'HTTPS', 'HTTP',
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC',
  'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'LOCAL', 'INTL', 'FOREIGN', 'CONTACTLESS', 'TAP', 'SETTLEMENT',
]);

/** Words that say nothing about WHO was paid: a line left with only these is rejected. */
const GENERIC_TOKENS = new Set([
  'CASH', 'DEPOSIT', 'WITHDRAWAL', 'ATM', 'FEE', 'FEES', 'CHARGE', 'CHARGES', 'SERVICE', 'SERVICES', 'MONTHLY',
  'ADMIN', 'INTEREST', 'RETURNED', 'REVERSAL', 'UNPAID', 'DISHONOURED', 'STOP', 'IMMEDIATE', 'REAL', 'TIME',
  'RECEIVED', 'RECEIPT', 'INWARD', 'OUTWARD', 'SWIFT', 'FOREX', 'RTC', 'VAT', 'SUNDRY', 'MISC', 'OTHER', 'GENERAL',
  'SUBSCRIPTION', 'RECURRING', 'BALANCE', 'BROUGHT', 'FORWARD', 'OPENING', 'CLOSING', 'ADJUSTMENT', 'CORRECTION',
]);

/** Words a person writes and a merchant name does not: any of them makes the line free text. */
const FREE_TEXT_MARKERS = new Set([
  'PLEASE', 'THANKS', 'THANK', 'YOU', 'FOR', 'MY', 'OUR', 'YOUR', 'HIS', 'HER', 'THEIR', 'MONTH', 'WEEK', 'PARTY',
  'GIFT', 'BIRTHDAY', 'KIDS', 'MOM', 'MOMMY', 'DAD', 'DADDY', 'MA', 'PA', 'BRU', 'BABY', 'LOVE',
]);

const IDENTIFIER_DIGITS = /\d{7,}/;
/** Dates and times are noise, not identifiers: removed before the digit-run check. */
const DATE_TIME = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}:\d{2}(:\d{2})?\b/g;
const PHONE_SHAPE = /(\+?27|\b0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/;
const MASKED_CARD = /[X*#]{4,}\s?\d{0,4}/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/;

function fold(raw: string): string {
  return raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

function tokens(text: string): string[] {
  return text
    .replace(MASKED_CARD, ' ')
    // Join intra-word punctuation so brands survive (PICK'N'PAY, K&M, E-TOLL, CELL-C).
    .replace(/([A-Z])['’&-]+(?=[A-Z])/g, '$1')
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Collapses the known two-token brands into one token, left to right. */
function joinPairs(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? KNOWN_MERCHANT_PAIRS[`${words[i]} ${words[i + 1]}`] : undefined;
    if (pair) {
      out.push(pair);
      i++;
      if (pair === 'PICKNPAY' && words[i + 1] === 'PAY') i++;
    } else {
      out.push(words[i]!);
    }
  }
  return out;
}

const reject = (reason: MerchantRejectReason): MerchantFilterResult => ({ ok: false, reason });

export function filterMerchant(raw: unknown): MerchantFilterResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) return reject('empty');
  const upper = fold(raw);
  if (EMAIL.test(upper)) return reject('contact_detail');
  const spaced = ` ${upper.replace(/[^A-Z0-9]+/g, ' ')} `;
  if (PERSON_PAYMENT_PATTERNS.some((p) => p.test(spaced))) return reject('person_payment');

  const undated = upper.replace(DATE_TIME, ' ');
  const hadIdentifier = IDENTIFIER_DIGITS.test(undated.replace(/[\s-]/g, '')) || PHONE_SHAPE.test(undated);
  const allWords = joinPairs(tokens(upper));
  const words = allWords.filter((w) => !NOISE_TOKENS.has(w));
  const brand = words.find((w) => KNOWN_MERCHANTS.has(w));
  if (hadIdentifier && !brand) return reject('identifier');

  // With a brand the key is the brand alone, so nothing else in the line is ever stored.
  if (!brand) {
    if (words.length > MAX_WORDS || words.some((w) => FREE_TEXT_MARKERS.has(w))) return reject('free_text');
    if (words.some((w) => HONORIFICS.has(w) || w.length === 1)) return reject('person_name');
    if (words.length > 0 && COMMON_FIRST_NAMES.has(words[0]!)) return reject('person_name');
  }
  const meaningful = words.filter((w) => !GENERIC_TOKENS.has(w));
  if (meaningful.length === 0) return reject(allWords.length === 0 ? 'empty' : 'generic');

  const merchant = brand ?? meaningful.slice(0, KEY_WORDS).join(' ');
  if (merchant.length < MIN_KEY_LENGTH && !brand) return reject('too_short');
  return { ok: true, merchant };
}

/** The pool key, or null when the filter rejects the text. */
export function poolMerchantKey(raw: unknown): string | null {
  const r = filterMerchant(raw);
  return r.ok ? r.merchant : null;
}
