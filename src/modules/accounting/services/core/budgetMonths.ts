/**
 * The month amounts of one budget, as the budget service stores them: one
 * amount per calendar month of a financial year (1-15 months; a transition
 * year after a change of year end is 14).
 *
 * Pure: the year's months arrive as 'YYYY-MM' keys.
 */

export interface BudgetMonthAmount {
  /** 'YYYY-MM'. */
  month: string;
  amount: number;
}

/** A refusal whose message is safe to show the caller (bad months, an unknown year, a foreign account). */
export class BudgetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetInputError';
  }
}

/**
 * `n` to cents, half away from zero on the DECIMAL value, as the NUMERIC(15,2)
 * column rounds: 1.005 is 1.01 (Math.round(1.005 * 100) is 100 because the float
 * is 1.00499...). The decimal point is shifted in the number's text; a number
 * whose text is exponential (1e-7 noise, or beyond a safe integer) takes the
 * float round, which is exact enough for both.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n) || Math.abs(n) >= Number.MAX_SAFE_INTEGER / 100) return n;
  const abs = Math.abs(n);
  const text = String(abs);
  const cents = text.includes('e') ? Math.round(abs * 100) : Math.round(Number(`${text}e2`));
  const out = (n < 0 ? -cents : cents) / 100;
  return out === 0 ? 0 : out;
}

/**
 * A financial-year LABEL from a request value: a whole number 1-9999 as a JSON
 * number or as 1-4 plain digits. `Number()` alone would take `true`, `'1e3'`,
 * `[2027]` and `' 2027'`. Null when it is not one.
 */
export function parseYearLabel(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,4}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : null;
}

