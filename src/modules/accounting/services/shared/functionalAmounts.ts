/**
 * The one TypeScript conversion of a document amount to the functional
 * currency (FX programme PR0): `ROUND(amount * rate, 2)`, half away from zero
 * — exactly what the SQL callers compute with
 * `public.fx_functional(amount::NUMERIC(15,2), rate::NUMERIC(18,6))`
 * (migration 871). The inputs are rounded as those casts round them first:
 * the amount to cents, the rate to six places, both half away from zero.
 *
 * Exact decimal, never float: `Math.round(x * r * 100) / 100` rounds 1.005 to
 * 1.00 and 4.35 * 100 to 434.99, and the FX plan only foots if the GL and the
 * subledger round alike. Use the SQL function wherever the figure can be
 * computed in the database; this twin is for what cannot (a form preview, and
 * later the leg distribution). tests/integration/fx-pr0-db.int.test.ts holds
 * the two to the cent; tests/unit/guards/fxConversionCensus.test.ts refuses a
 * multiplication by an exchange rate anywhere else.
 *
 * Pure: no imports, safe in a client bundle.
 */

/** An input that is not a plain finite decimal (NaN, Infinity, 1e21, 'abc'): callers answer it 400. */
export class NotADecimalError extends Error {
  constructor(value: unknown) {
    super(`${typeof value === 'string' ? JSON.stringify(value) : String(value)} is not a finite decimal`);
    this.name = 'NotADecimalError';
  }
}

interface Decimal {
  digits: bigint;
  scale: number;
}

function parseDecimal(value: number | string): Decimal {
  let text = typeof value === 'number' ? String(value) : value.trim();
  if (typeof value === 'number' && !Number.isFinite(value)) throw new NotADecimalError(value);
  if (/e/i.test(text) && typeof value === 'number') text = value.toFixed(20);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new NotADecimalError(value);
  const fraction = match[3] ?? '';
  const digits = BigInt(`${match[2]}${fraction}`);
  return { digits: match[1] === '-' ? -digits : digits, scale: fraction.length };
}

/** `ROUND(d, places)`, half away from zero, as numeric round() does. */
function roundTo(d: Decimal, places: number): Decimal {
  if (d.scale <= places) return d;
  const divisor = 10n ** BigInt(d.scale - places);
  const magnitude = d.digits < 0n ? -d.digits : d.digits;
  const rounded = (magnitude + divisor / 2n) / divisor;
  return { digits: d.digits < 0n ? -rounded : rounded, scale: places };
}

/** `fx_functional(amount::NUMERIC(15,2), rate::NUMERIC(18,6))`, as a number of rands. */
export function toFunctional(amount: number | string, rate: number | string): number {
  const a = roundTo(parseDecimal(amount), 2);
  const r = roundTo(parseDecimal(rate), 6);
  const cents = roundTo({ digits: a.digits * r.digits, scale: a.scale + r.scale }, 2);
  return Number(cents.digits * 10n ** BigInt(2 - cents.scale)) / 100;
}
