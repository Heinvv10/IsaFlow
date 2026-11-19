/**
 * The VAT on one document line, and a document's totals over its lines: the one calculation every
 * document is moving onto (per-line VAT programme, 2026-11-19).
 *
 *   exclusive:  net = ROUND(amount, 2)    vat = ROUND(net × rate / 100, 2)             gross = net + vat
 *   inclusive:  gross = ROUND(amount, 2)  vat = ROUND(gross × rate / (100 + rate), 2)  net = gross − vat
 *   document:   subtotal = Σ net          vat = Σ vat                                  total = subtotal + vat
 *
 * VAT is rounded on the LINE and the document is the sum of its lines, so a document mixing standard,
 * zero-rated and exempt lines foots, and each line's VAT is what its own type and rate produce. The
 * rate is the type's on the document date (vatTypes). Exact decimal, half away from zero, never float.
 *
 * Pure: safe in a client bundle.
 */
import type { VatType } from '../../types/gl.types';
import { parseDecimal, roundTo } from './functionalAmounts';
import { vatRatePctOn } from './vatTypes';

export type AmountsAre = 'exclusive' | 'inclusive';

export interface VatLineAmounts {
  net: number;
  vat: number;
  gross: number;
  ratePct: number;
}

const toCents = (n: number): bigint => {
  const d = roundTo(parseDecimal(n), 2);
  return d.digits * 10n ** BigInt(2 - d.scale);
};
const rands = (cents: bigint): number => Number(cents) / 100;

/** n / d rounded to an integer, half away from zero (d > 0). */
const divRound = (n: bigint, d: bigint): bigint => {
  const q = ((n < 0n ? -n : n) * 2n + d) / (d * 2n);
  return n < 0n ? -q : q;
};

/**
 * quantity × unit price to the cent, multiplied as decimals: the float product of 3 × 1.005 is
 * 3.0149999999999997, which rounds to 3.01. Throws NotADecimalError on a non-finite input.
 */
export function lineAmount(quantity: number, unitPrice: number): number {
  const q = parseDecimal(quantity);
  const p = parseDecimal(unitPrice);
  const product = roundTo({ digits: q.digits * p.digits, scale: q.scale + p.scale }, 2);
  return rands(product.digits * 10n ** BigInt(2 - product.scale));
}

/** One line's net, VAT and gross (see the header). Throws NotADecimalError on a non-finite amount. */
export function vatLineAmounts(
  amount: number, vatType: VatType, date: string | Date, amountsAre: AmountsAre = 'exclusive',
): VatLineAmounts {
  const ratePct = vatRatePctOn(vatType, date);
  const stated = toCents(amount);
  const rate = BigInt(ratePct);
  if (amountsAre === 'inclusive') {
    const vat = divRound(stated * rate, 100n + rate);
    return { net: rands(stated - vat), vat: rands(vat), gross: rands(stated), ratePct };
  }
  const vat = divRound(stated * rate, 100n);
  return { net: rands(stated), vat: rands(vat), gross: rands(stated + vat), ratePct };
}

/** The document over its lines. */
export function vatDocumentTotals(lines: ReadonlyArray<Pick<VatLineAmounts, 'net' | 'vat'>>): { subtotal: number; vat: number; total: number } {
  const subtotal = lines.reduce((s, l) => s + toCents(l.net), 0n);
  const vat = lines.reduce((s, l) => s + toCents(l.vat), 0n);
  return { subtotal: rands(subtotal), vat: rands(vat), total: rands(subtotal + vat) };
}

/**
 * The label of a document's VAT total. A header holds ONE rate, so the rate is quoted only when the VAT is
 * that rate on the whole subtotal, give or take ten cents of per-line rounding (twenty lines at half a cent
 * each). A document mixing rated and unrated lines is further out than that and reads plain "VAT".
 */
export function vatTotalLabel(doc: { subtotal: number; ratePct: number; vat: number }): string {
  const { subtotal, ratePct, vat } = doc;
  // A figure that did not arrive (NaN from a missing field) has no rate to quote; a label must not throw in render.
  if (![subtotal, ratePct, vat].every((n) => Number.isFinite(n) && Math.abs(n) < 1e13)) return 'VAT';
  const implied = divRound(toCents(subtotal) * toCents(ratePct), 10000n);
  const out = implied - toCents(vat);
  return (out < 0n ? -out : out) <= 10n ? `VAT (${ratePct}%)` : 'VAT';
}
