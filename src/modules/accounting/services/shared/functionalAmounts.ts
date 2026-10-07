/**
 * The one TypeScript conversion of a document amount to the functional
 * currency (FX programme PR0): `ROUND(amount * rate, 2)`, half away from zero
 * — exactly what `public.fx_functional` (migration 871) computes in SQL.
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

interface Decimal {
  digits: bigint;
  scale: number;
}

function parseDecimal(value: number | string): Decimal {
  let text = typeof value === 'number' ? String(value) : value.trim();
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${value} is not a finite decimal`);
  if (/e/i.test(text) && typeof value === 'number') text = value.toFixed(20);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`${JSON.stringify(value)} is not a finite decimal`);
  const fraction = match[3] ?? '';
  const digits = BigInt(`${match[2]}${fraction}`);
  return { digits: match[1] === '-' ? -digits : digits, scale: fraction.length };
}

/** `ROUND(amount * rate, 2)`, half away from zero, as a number of rands. */
export function toFunctional(amount: number | string, rate: number | string): number {
  const a = parseDecimal(amount);
  const r = parseDecimal(rate);
  const product = a.digits * r.digits;
  const scale = a.scale + r.scale;
  let cents: bigint;
  if (scale <= 2) {
    cents = product * 10n ** BigInt(2 - scale);
  } else {
    const divisor = 10n ** BigInt(scale - 2);
    const magnitude = product < 0n ? -product : product;
    const rounded = (magnitude + divisor / 2n) / divisor;
    cents = product < 0n ? -rounded : rounded;
  }
  return Number(cents) / 100;
}
