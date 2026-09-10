/**
 * Is every currency this document names the rand?
 *
 * The unattended gate posts the figures a document prints as rand. A document
 * priced in anything else must go to a person, and K-072 has now been beaten
 * three rounds running by a currency the list did not spell: `USD` before the
 * figure (round 16), `€` after it and `(US Dollars)` (round 17), and `US$`,
 * `MZN`, `MT`, `Pula`, `Kwacha`, `Rupees` after the figure (round 18) — the last
 * two are routine on a Mozambican or Zambian invoice.
 *
 * So the test is INVERTED: a document passes only when every currency-like mark
 * beside an amount is the rand (`R`, `ZAR`, `rand`). Beside a cents figure, any
 * currency symbol, any `X$` form and any uppercase code of two or three
 * letters refuses unless it is on `NOT_A_CURRENCY` — a closed list of the
 * ordinary words a till prints beside an amount (`VAT`, `EFT`, `QTY`...). That
 * list FAILS CLOSED: a word missing from it costs a refusal, never a post. A
 * single letter beside a figure is a VAT-band marker (`32.99 A`) and is left
 * alone, as is a code glued to a digit in front of it (`DIESEL 50PPM 52.10`).
 *
 * Spelled-out names (`Kwacha`, `Dollars`) cannot be inverted — any word may sit
 * beside an amount — so they remain a list, and **a name missing from it is the
 * one remaining open direction in this file: it fails OPEN.** A code printed
 * away from any figure is caught two ways: a currency DECLARATION (`Currency:
 * MUR`) refuses unless it names the rand, and a broad ISO list refuses anywhere
 * — except a code that is also a word (`GEL`), which must sit beside a number.
 */

/**
 * Words that sit beside an amount and are not a currency. Closed; fails closed.
 * Round 19 had `SR` here — the Saudi riyal and the Seychelles rupee — and `KGS`
 * and `KM`, both currency codes; none of those is a till word worth the risk.
 */
const NOT_A_CURRENCY = new Set([
  'ZAR', 'VAT', 'BTW', 'TAX', 'EFT', 'QTY', 'AMT', 'DUE', 'NET', 'TIP', 'SUB', 'TTL', 'TOT',
  'POS', 'REF', 'INV', 'ACC', 'PIN', 'ULP', 'LRP', 'FEE', 'CHG', 'SVC', 'DEL', 'EXC', 'INC',
  'EXCL', 'INCL', 'KMS', 'PCS', 'EA', 'EACH', 'KG', 'ML', 'LT', 'CR', 'DR', 'KT',
  'ZR', 'EX', 'ST', 'NO', 'NR', 'PC', 'PER', 'CASH', 'CARD', 'VISA', 'AMEX', 'PAID', 'NETT',
  'LESS', 'PLUS', 'BAL', 'SLIP', 'LINE', 'ONLY', 'BY', 'OF', 'TO', 'AT', 'ON', 'IN', 'OR', 'AND',
  'FOR', 'THE', 'VIA', 'OFF', 'NOW', 'IS', 'WAS', 'ARE', 'BE', 'IT',
  'EN', 'VIR', 'OP', 'TE', 'DIE', 'VAN', 'MET', 'OM', 'TOT', 'BTW', 'KAS', 'KAART', 'BETAAL',
]);

const SYMBOL = /(?:[A-Z]{0,2}\$|[€£¥₹₦₵₺₽฿₩₫₱]|zł|Kč)/;
const CENTS = String.raw`\d[\d \u00A0.,]*[.,]\d{2}(?!\d)`;
/** Before a figure: uppercase only — an item name sits there too (`Tea 18.00`). */
const CODE_BEFORE = new RegExp(String.raw`(?<![A-Za-z0-9])([A-Z]{2,3})(?![A-Za-z])[ \t]*:?[ \t]*(?=${CENTS})`, 'g');
/** After a figure: ANY case, up to four letters (`Rs`, `kr`, `FCFA`) — nothing but a band mark sits there. */
const CODE_AFTER = new RegExp(String.raw`${CENTS}[ \t]*([A-Za-z]{2,4})(?![A-Za-z])`, 'g');
/** A lone `P` closing a figure's line is the Botswana pula; other single letters are VAT bands. */
const PULA = new RegExp(String.raw`${CENTS}[ \t]*P[ \t]*$`, 'm');
const SYMBOL_BESIDE = new RegExp(String.raw`${SYMBOL.source}[ \t]*\d|\d[ \t]*${SYMBOL.source}`);
/**
 * A currency DECLARED anywhere refuses unless it is the rand: a currency label
 * (`Currency: MUR`, `CCY - USD`) or an "amounts in" statement (`All amounts in
 * MVR`, `Payable in US funds`, `Prices in ZiG`, `All amounts shown in ZiG`).
 * The word after "in" refuses unless it is the rand or one of the ordinary
 * words `NOT_DECLARED` lists (`Payable in full`, `Amount in words`) — a closed
 * list that FAILS CLOSED: a missing word costs a refusal, never a post.
 */
const DECLARED = /(?<![A-Za-z])(?:(?:Currency|Curr|CCY|Valuta|Geldeenheid)(?![A-Za-z])(?:\s*code)?\s*[:=.-]?|(?:amounts?|payable|bedrae|prices?|pryse|figures?|values?|rates?)(?:\s+(?:are|is|shown|stated|quoted|given|expressed|reflected|displayed))*\s+in(?=\s))\s*([A-Za-z]+)/gi;
const NOT_DECLARED = /^(?:ZAR|R|Rands?|SA|South|full|advance|arrears|words|writing|instalments?|terms|accordance|respect|total|store|stock|brackets|this|these|the|our|your|all|each|one|two|three|cash|person|part)$/i;
/** Mixed-case codes printed BEFORE a figure, where uppercase-only misses them (`TOTAL Rs 115.00`). */
const MIXED_CODE_BEFORE = new RegExp(String.raw`(?<![A-Za-z])(?:Rs|Rp|Kr|Ksh|Tsh|Ush|Kz|Le|Ft|Kč)\.?[ \t]*(?=${CENTS})`);
/**
 * ISO codes that are ALSO words a till prints (`SHOWER GEL`, `AMD RYZEN`, `TRY
 * OUR…`, `BBQ RUB`, `LAK` — Afrikaans lacquer) refuse only BESIDE a number:
 * elsewhere they are words, and anywhere they refused ordinary slips. A code
 * that is no word refuses wherever it is printed.
 */
const WORD_CODES = 'GEL|AMD|TRY|MAD|RON|RUB|CAD|PHP|KGS|LAK';
const WORD_CODE_BESIDE = new RegExp(String.raw`(?<![A-Za-z])(?:${WORD_CODES})[ \t]*:?[ \t]*\d[\d \u00A0.,]*(?![\dA-Za-z])|\d[ \t]*(?:${WORD_CODES})(?![A-Za-z])`);
const ISO_ANYWHERE = /(?<![A-Za-z])(?:USD|EUR|GBP|AUD|NZD|CHF|JPY|CNY|HKD|SGD|INR|PKR|LKR|BDT|NGN|GHS|KES|TZS|UGX|RWF|BIF|ETB|CDF|AOA|BWP|NAD|SZL|LSL|MZN|ZMW|MWK|ZWL|ZWG|MGA|MUR|SCR|KMF|XOF|XAF|EGP|TND|AED|SAR|QAR|KWD|BHD|OMR|DKK|SEK|NOK|PLN|CZK|HUF|BRL|MXN|ARS|KRW|KZT|THB|MYR|IDR|MVR|VND|ILS|BGN|UAH|AZN|SGD|TWD|LKR|NPR|MMK|KHR)(?![A-Za-z])/;
const SPELLED = /(?<![A-Za-z])(?:(?:US|American|Australian|Canadian)\s+)?(?:Dollars?|Euros?|Pounds?\s+Sterling|Sterling|Yen|Yuan|Renminbi|Naira|Pula|Kwacha|Metical|Meticais|Rupees?|Dirhams?|Shillings?|Cedis?|Birr|Kwanza|Emalangeni|Lilangeni|Maloti|Loti|Riyals?|Ringgit|Baht|Francs?|Kroner|Kronor|Krone|Pesos?|Ariary|Dinars?|Rials?|Lira|Zloty|Reais|Rufiyaa|Leones?|Rupiah|Tenge|Forint|Nakfa|Dalasi|Hryvnia|Shekels?|Quetzal|Manat|Denar|Afghani|Gourde|Ouguiya|Dobra|Escudos?|Bitcoin|BTC|Zimbabwe\s+Gold|US\s+funds)(?![A-Za-z])/i;
/**
 * Names that are also ordinary words count only AFTER a figure: `won` is
 * English, and `som` is Afrikaans for "sum" and prints BEFORE one (`Die totale
 * som 115.00`).
 */
const SPELLED_BESIDE = new RegExp(String.raw`${CENTS}[ \t]*(?:Won|Som)(?![A-Za-z])`);

export function namesForeignCurrency(text: string): boolean {
  if (ISO_ANYWHERE.test(text) || WORD_CODE_BESIDE.test(text) || SYMBOL_BESIDE.test(text) || SPELLED.test(text)) return true;
  if (SPELLED_BESIDE.test(text) || PULA.test(text) || MIXED_CODE_BEFORE.test(text)) return true;
  for (const match of text.matchAll(DECLARED)) {
    if (!NOT_DECLARED.test(match[1]!)) return true;
  }
  for (const pattern of [CODE_BEFORE, CODE_AFTER]) {
    for (const match of text.matchAll(pattern)) {
      if (!NOT_A_CURRENCY.has(match[1]!.toUpperCase())) return true;
    }
  }
  return false;
}
