// WORKING: pure computation — no DB, no side effects
export interface ExchangeRateInput {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  effectiveDate: string; // YYYY-MM-DD
}

export interface ExchangeRate extends ExchangeRateInput {
  id?: string;
}

export interface ConversionResult {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
}

export interface FXGainLoss {
  amount: number; // positive = gain, negative = loss
  currency: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CURRENCY_SYMBOLS: Record<string, string> = {
  ZAR: 'R',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

/**
 * Convert `amount` from one currency to another using the provided rate.
 * Throws when rate ≤ 0.
 * Returns the original amount unchanged when fromCurrency === toCurrency.
 */
export function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rate: number,
): number {
  if (rate <= 0) {
    throw new Error(`Exchange rate must be greater than 0, received ${rate}`);
  }
  if (fromCurrency === toCurrency) {
    return amount;
  }
  return Math.round(amount * rate * 100) / 100;
}

/**
 * Validate an ExchangeRateInput for correctness.
 * Returns { valid, errors } where errors is an array of human-readable messages.
 */
export function validateExchangeRate(input: ExchangeRateInput): ValidationResult {
  const errors: string[] = [];

  if (!input.fromCurrency || input.fromCurrency.trim() === '') {
    errors.push('fromCurrency is required');
  }

  if (!input.toCurrency || input.toCurrency.trim() === '') {
    errors.push('toCurrency is required');
  }

  if (
    input.fromCurrency &&
    input.toCurrency &&
    input.fromCurrency === input.toCurrency
  ) {
    errors.push('fromCurrency and toCurrency must not be the same currency');
  }

  if (input.rate <= 0) {
    errors.push('rate must be greater than 0');
  } else if (input.rate > 10000) {
    errors.push('rate exceeds maximum allowed value of 10000');
  }

  if (!ISO_DATE_RE.test(input.effectiveDate)) {
    errors.push('effectiveDate must be a valid date in YYYY-MM-DD format');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Find the exchange rate applicable on `date` for the given currency pair.
 *
 * - Returns a synthetic rate of 1.0 when fromCurrency === toCurrency.
 * - Returns an exact match if one exists, otherwise the most-recent rate with
 *   effectiveDate ≤ date.
 * - Returns null when no suitable rate is found (including when date is before
 *   all available rates or the currency pair is absent).
 */
export function getExchangeRateForDate(
  rates: ExchangeRate[],
  fromCurrency: string,
  toCurrency: string,
  date: string,
): ExchangeRate | null {
  if (fromCurrency === toCurrency) {
    return { fromCurrency, toCurrency, rate: 1.0, effectiveDate: date };
  }

  const matching = rates.filter(
    (r) =>
      r.fromCurrency === fromCurrency &&
      r.toCurrency === toCurrency &&
      r.effectiveDate <= date,
  );

  if (matching.length === 0) return null;

  // Sort descending by date and take the most recent
  matching.sort((a, b) => (a.effectiveDate > b.effectiveDate ? -1 : 1));
  return matching[0] ?? null;
}

/**
 * Calculate FX gain or loss on a foreign-currency asset/liability.
 *
 * Formula: (originalRate - currentRate) * originalAmount
 *   positive → gain (domestic currency strengthened)
 *   negative → loss (domestic currency weakened)
 *
 * Result is expressed in the domestic (ZAR) reporting currency.
 */
export function calculateFXGainLoss(
  originalAmount: number,
  originalRate: number,
  currentRate: number,
  _currency: string,
): number {
  if (originalAmount === 0) return 0;
  return Math.round((originalRate - currentRate) * originalAmount * 100) / 100;
}

/**
 * Format `amount` as a localised currency string.
 *
 * Known symbols: ZAR → R, USD → $, EUR → €, GBP → £
 * Unknown codes use the ISO code as the prefix.
 *
 * Example output: "R 1,234.56"
 */
export function formatCurrencyAmount(amount: number, currencyCode: string): string {
  const symbol = CURRENCY_SYMBOLS[currencyCode] ?? currencyCode;
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol} ${formatted}`;
}
