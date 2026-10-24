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

export interface BudgetAmountsInput {
  /** Exactly the year's months, each once, any order. */
  months?: BudgetMonthAmount[];
  /** Spread evenly over the year's months when `months` is absent. */
  annualAmount?: number;
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

/** `annual` over `count` months: equal cents, the remainder on the last month. */
export function spreadEvenly(annual: number, count: number): number[] {
  const monthly = round2(annual / count);
  const out = Array<number>(count).fill(monthly);
  out[count - 1] = round2(annual - monthly * (count - 1));
  return out;
}

function finiteAmount(value: unknown, what: string): number {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n)) throw new BudgetInputError(`${what} must be a number`);
  return round2(n);
}

/**
 * The amounts to store for `monthKeys` (the year's months, in order): the
 * explicit split when given, else the annual spread. An explicit split must
 * name exactly the year's months, so a grid built for another year, or a
 * stale column set, is refused instead of filed under the wrong months.
 */
export function resolveMonthAmounts(monthKeys: readonly string[], input: BudgetAmountsInput): BudgetMonthAmount[] {
  if (monthKeys.length === 0) throw new BudgetInputError('The financial year has no months');
  if (input.months) {
    const given = new Map<string, number>();
    for (const m of input.months) {
      if (given.has(m.month)) throw new BudgetInputError(`Month ${m.month} is given twice`);
      given.set(m.month, finiteAmount(m.amount, `Amount for ${m.month}`));
    }
    const missing = monthKeys.filter(k => !given.has(k));
    const extra = [...given.keys()].filter(k => !monthKeys.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      throw new BudgetInputError(
        `Months must be exactly ${monthKeys[0]} to ${monthKeys[monthKeys.length - 1]} (${monthKeys.length} months)` +
        (missing.length > 0 ? `; missing ${missing.join(', ')}` : '') +
        (extra.length > 0 ? `; not in this year: ${extra.join(', ')}` : ''),
      );
    }
    return monthKeys.map(month => ({ month, amount: given.get(month)! }));
  }
  if (input.annualAmount === undefined) throw new BudgetInputError('Either months or annualAmount is required');
  const spread = spreadEvenly(finiteAmount(input.annualAmount, 'annualAmount'), monthKeys.length);
  return monthKeys.map((month, i) => ({ month, amount: spread[i]! }));
}
