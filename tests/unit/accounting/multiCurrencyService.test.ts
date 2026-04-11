// RED phase — written before implementation
import { describe, it, expect } from 'vitest';
import {
  convertAmount,
  validateExchangeRate,
  getExchangeRateForDate,
  calculateFXGainLoss,
  formatCurrencyAmount,
  type ExchangeRateInput,
  type ExchangeRate,
} from '@/modules/accounting/services/multiCurrencyService';

// ---------------------------------------------------------------------------
// convertAmount
// ---------------------------------------------------------------------------
describe('convertAmount', () => {
  it('converts ZAR 1000 to USD at rate 0.054 → 54.00', () => {
    expect(convertAmount(1000, 'ZAR', 'USD', 0.054)).toBeCloseTo(54.0, 2);
  });

  it('converts USD 100 to ZAR at rate 18.50 → 1850.00', () => {
    expect(convertAmount(100, 'USD', 'ZAR', 18.5)).toBeCloseTo(1850.0, 2);
  });

  it('returns same amount when fromCurrency === toCurrency regardless of rate', () => {
    expect(convertAmount(500, 'ZAR', 'ZAR', 999)).toBe(500);
  });

  it('rounds to 2 decimal places: 1000 ZAR at 0.0543 → 54.30', () => {
    expect(convertAmount(1000, 'ZAR', 'USD', 0.0543)).toBeCloseTo(54.3, 2);
  });

  it('returns 0 for amount 0', () => {
    expect(convertAmount(0, 'ZAR', 'USD', 0.054)).toBe(0);
  });

  it('throws when rate is 0', () => {
    expect(() => convertAmount(100, 'ZAR', 'USD', 0)).toThrow();
  });

  it('throws when rate is negative', () => {
    expect(() => convertAmount(100, 'ZAR', 'USD', -1.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateExchangeRate
// ---------------------------------------------------------------------------
describe('validateExchangeRate', () => {
  const validInput: ExchangeRateInput = {
    fromCurrency: 'USD',
    toCurrency: 'ZAR',
    rate: 18.5,
    effectiveDate: '2026-01-01',
  };

  it('accepts a valid exchange rate input', () => {
    const result = validateExchangeRate(validInput);
    expect(result.valid).toBe(true);
  });

  it('rejects rate ≤ 0', () => {
    const result = validateExchangeRate({ ...validInput, rate: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(/rate/i));
  });

  it('rejects negative rate', () => {
    const result = validateExchangeRate({ ...validInput, rate: -5 });
    expect(result.valid).toBe(false);
  });

  it('rejects missing fromCurrency', () => {
    const result = validateExchangeRate({ ...validInput, fromCurrency: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(/fromCurrency/i));
  });

  it('rejects fromCurrency === toCurrency', () => {
    const result = validateExchangeRate({ ...validInput, fromCurrency: 'ZAR', toCurrency: 'ZAR' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(/same/i));
  });

  it('rejects invalid date format', () => {
    const result = validateExchangeRate({ ...validInput, effectiveDate: '01-01-2026' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(/date/i));
  });

  it('rejects rate > 10000 (sanity check)', () => {
    const result = validateExchangeRate({ ...validInput, rate: 10001 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(/rate/i));
  });
});

// ---------------------------------------------------------------------------
// getExchangeRateForDate
// ---------------------------------------------------------------------------
describe('getExchangeRateForDate', () => {
  const rates: ExchangeRate[] = [
    { fromCurrency: 'USD', toCurrency: 'ZAR', rate: 17.0, effectiveDate: '2026-01-01' },
    { fromCurrency: 'USD', toCurrency: 'ZAR', rate: 18.0, effectiveDate: '2026-02-01' },
    { fromCurrency: 'USD', toCurrency: 'ZAR', rate: 18.5, effectiveDate: '2026-03-01' },
  ];

  it('returns exact match for the given date', () => {
    const result = getExchangeRateForDate(rates, 'USD', 'ZAR', '2026-02-01');
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(18.0);
  });

  it('returns most recent rate before the given date when no exact match', () => {
    const result = getExchangeRateForDate(rates, 'USD', 'ZAR', '2026-02-15');
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(18.0);
  });

  it('returns null when no rate found for the currency pair', () => {
    const result = getExchangeRateForDate(rates, 'EUR', 'ZAR', '2026-03-01');
    expect(result).toBeNull();
  });

  it('returns 1.0 when fromCurrency === toCurrency (no rate lookup needed)', () => {
    const result = getExchangeRateForDate(rates, 'ZAR', 'ZAR', '2026-03-01');
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(1.0);
  });

  it('uses the closest prior date when multiple rates exist before the query date', () => {
    const result = getExchangeRateForDate(rates, 'USD', 'ZAR', '2026-03-15');
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(18.5);
  });

  it('returns null when query date is before all available rates', () => {
    const result = getExchangeRateForDate(rates, 'USD', 'ZAR', '2025-12-31');
    expect(result).toBeNull();
  });

  it('returns null for empty rates array', () => {
    const result = getExchangeRateForDate([], 'USD', 'ZAR', '2026-03-01');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// calculateFXGainLoss
// ---------------------------------------------------------------------------
describe('calculateFXGainLoss', () => {
  it('returns positive gain when ZAR strengthens (foreign currency rate decreases)', () => {
    // Bought USD 1000 at ZAR 18.50; now rate is ZAR 17.00 — ZAR is stronger, gain in ZAR terms
    const result = calculateFXGainLoss(1000, 18.5, 17.0, 'USD');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeCloseTo(1500, 2); // (18.5 - 17.0) * 1000
  });

  it('returns negative loss when ZAR weakens (foreign currency rate increases)', () => {
    // Bought USD 1000 at ZAR 17.00; now rate is ZAR 18.50 — ZAR is weaker, loss in ZAR terms
    const result = calculateFXGainLoss(1000, 17.0, 18.5, 'USD');
    expect(result).toBeLessThan(0);
    expect(result).toBeCloseTo(-1500, 2); // (17.0 - 18.5) * 1000
  });

  it('returns 0 when rates are equal', () => {
    const result = calculateFXGainLoss(1000, 18.5, 18.5, 'USD');
    expect(result).toBe(0);
  });

  it('returns gain/loss in ZAR', () => {
    const result = calculateFXGainLoss(500, 20.0, 19.0, 'USD');
    // (20.0 - 19.0) * 500 = 500 ZAR gain
    expect(result).toBeCloseTo(500, 2);
  });

  it('returns 0 for zero original amount', () => {
    const result = calculateFXGainLoss(0, 18.5, 17.0, 'USD');
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatCurrencyAmount
// ---------------------------------------------------------------------------
describe('formatCurrencyAmount', () => {
  it('formats ZAR as "R 1,234.56"', () => {
    expect(formatCurrencyAmount(1234.56, 'ZAR')).toBe('R 1,234.56');
  });

  it('formats USD as "$ 1,234.56"', () => {
    expect(formatCurrencyAmount(1234.56, 'USD')).toBe('$ 1,234.56');
  });

  it('formats EUR as "€ 1,234.56"', () => {
    expect(formatCurrencyAmount(1234.56, 'EUR')).toBe('€ 1,234.56');
  });

  it('formats GBP as "£ 1,234.56"', () => {
    expect(formatCurrencyAmount(1234.56, 'GBP')).toBe('£ 1,234.56');
  });

  it('falls back to "XXX 1,234.56" for unknown currency code', () => {
    expect(formatCurrencyAmount(1234.56, 'XXX')).toBe('XXX 1,234.56');
  });

  it('formats zero correctly', () => {
    expect(formatCurrencyAmount(0, 'ZAR')).toBe('R 0.00');
  });

  it('formats large amounts with correct thousands separators', () => {
    expect(formatCurrencyAmount(1000000.0, 'ZAR')).toBe('R 1,000,000.00');
  });
});
