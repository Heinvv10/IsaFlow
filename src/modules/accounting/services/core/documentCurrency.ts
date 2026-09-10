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
 * beside an amount — so they remain a list, and a name missing from it is the
 * one remaining open direction in this file. The ISO list catches a code that
 * is printed nowhere near a figure (`Currency: USD`).
 */

/** Uppercase words that sit beside an amount and are not a currency. Closed; fails closed. */
const NOT_A_CURRENCY = new Set([
  'ZAR', 'VAT', 'BTW', 'TAX', 'EFT', 'QTY', 'AMT', 'DUE', 'NET', 'TIP', 'SUB', 'TTL', 'TOT',
  'POS', 'REF', 'INV', 'ACC', 'PIN', 'ULP', 'LRP', 'FEE', 'CHG', 'SVC', 'DEL', 'EXC', 'INC',
  'EXCL', 'INCL', 'KMS', 'KGS', 'PCS', 'EA', 'KG', 'KM', 'ML', 'LT', 'CR', 'DR', 'KT',
  'SR', 'ZR', 'EX', 'ST', 'NO', 'NR', 'PC',
]);

const SYMBOL = /(?:[A-Z]{0,2}\$|[€£¥₹₦])/;
const CENTS = String.raw`\d[\d \u00A0.,]*[.,]\d{2}(?!\d)`;
const CODE_BEFORE = new RegExp(String.raw`(?<![A-Za-z0-9])([A-Z]{2,3})(?![A-Za-z])[ \t]*:?[ \t]*(?=${CENTS})`, 'g');
const CODE_AFTER = new RegExp(String.raw`${CENTS}[ \t]*([A-Z]{2,3})(?![A-Za-z])`, 'g');
const SYMBOL_BESIDE = new RegExp(String.raw`${SYMBOL.source}[ \t]*\d|\d[ \t]*${SYMBOL.source}`);
const ISO_ANYWHERE = /(?<![A-Za-z])(?:USD|EUR|GBP|AUD|CAD|CHF|JPY|CNY|INR|NGN|KES|BWP|NAD|ZWL|MZN|ZMW|MWK|AED)(?![A-Za-z])/;
const SPELLED = /(?<![A-Za-z])(?:(?:US|American|Australian|Canadian)\s+)?(?:Dollars?|Euros?|Pounds?\s+Sterling|Sterling|Yen|Yuan|Renminbi|Naira|Pula|Kwacha|Metical|Meticais|Rupees?|Dirhams?|Shillings?|Cedis?|Birr|Kwanza|Emalangeni|Lilangeni|Maloti|Loti|Riyals?|Ringgit|Baht|Francs?)(?![A-Za-z])/i;

export function namesForeignCurrency(text: string): boolean {
  if (ISO_ANYWHERE.test(text) || SYMBOL_BESIDE.test(text) || SPELLED.test(text)) return true;
  for (const pattern of [CODE_BEFORE, CODE_AFTER]) {
    for (const match of text.matchAll(pattern)) {
      if (!NOT_A_CURRENCY.has(match[1]!)) return true;
    }
  }
  return false;
}
