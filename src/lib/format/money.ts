/**
 * Statement figure formatting. One place, so a number looks the same on the
 * screen, in the pack and in the PDF. Conventions: thousands separated by a
 * narrow space (en-ZA), negatives in parentheses, zero as an en dash.
 */
const ZERO_DASH = '–';
const MINUS = '−';

const whole = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function signOf(n: number): 'pos' | 'neg' | 'zero' {
  // A non-finite figure has no sign to speak of. Without this it fell through
  // to 'pos' and the statement printed "NaN" or "+NaN%" in a money column.
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return 'zero';
  return n < 0 ? 'neg' : 'pos';
}

export function formatMoney(n: number, opts: { cents?: boolean; symbol?: boolean } = {}): string {
  const s = signOf(n);
  if (s === 'zero') return ZERO_DASH;
  const body = (opts.cents ? cents : whole)
    .format(Math.abs(n))
    .replace(/[\xa0\u202f]/g, ' ')
    .replace(/,/g, '.');
  const withSymbol = opts.symbol ? `R ${body}` : body;
  return s === 'neg' ? `(${withSymbol})` : withSymbol;
}

export function formatPct(n: number, dp = 1): string {
  // A dash, not "0.0%": a percentage that could not be computed must not read
  // as a percentage of zero.
  if (!Number.isFinite(n)) return ZERO_DASH;
  const s = signOf(n);
  const body = `${Math.abs(n).toFixed(dp)}%`;
  if (s === 'zero') return `0.${'0'.repeat(dp)}%`;
  return s === 'neg' ? `${MINUS}${body}` : `+${body}`;
}
