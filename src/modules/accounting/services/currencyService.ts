/**
 * Currency & Exchange Rate Service
 * Multi-currency foundation for accounting
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isActive: boolean;
}

export interface ExchangeRate {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  effectiveDate: string;
  source: string;
}

// ── Currencies ──────────────────────────────────────────────────────────────

export async function getCurrencies(companyId: string, activeOnly = true): Promise<Currency[]> {
  const rows = activeOnly
    ? ((await sql`SELECT * FROM currencies WHERE company_id = ${companyId} AND is_active = true ORDER BY code`) as Row[])
    : ((await sql`SELECT * FROM currencies WHERE company_id = ${companyId} ORDER BY code`) as Row[]);
  return rows.map(mapCurrency);
}

export async function createCurrency(companyId: string, input: {
  code: string; name: string; symbol: string; decimalPlaces?: number;
}): Promise<Currency> {
  const rows = (await sql`
    INSERT INTO currencies (company_id, code, name, symbol, decimal_places)
    VALUES (${companyId}, ${input.code.toUpperCase()}, ${input.name}, ${input.symbol}, ${input.decimalPlaces || 2})
    RETURNING *
  `) as Row[];
  log.info('Created currency', { code: input.code }, 'accounting');
  return mapCurrency(rows[0]!);
}

export async function toggleCurrency(companyId: string, code: string, isActive: boolean): Promise<void> {
  await sql`UPDATE currencies SET is_active = ${isActive} WHERE code = ${code} AND company_id = ${companyId}`;
}

// ── Exchange Rates ──────────────────────────────────────────────────────────

export async function getExchangeRates(companyId: string, filters?: {
  fromCurrency?: string; toCurrency?: string; limit?: number;
}): Promise<ExchangeRate[]> {
  const limit = filters?.limit || 100;

  if (filters?.fromCurrency && filters?.toCurrency) {
    const rows = (await sql`
      SELECT * FROM exchange_rates
      WHERE company_id = ${companyId}
        AND from_currency = ${filters.fromCurrency} AND to_currency = ${filters.toCurrency}
      ORDER BY effective_date DESC LIMIT ${limit}
    `) as Row[];
    return rows.map(mapRate);
  }
  if (filters?.fromCurrency) {
    const rows = (await sql`
      SELECT * FROM exchange_rates
      WHERE company_id = ${companyId} AND from_currency = ${filters.fromCurrency}
      ORDER BY effective_date DESC LIMIT ${limit}
    `) as Row[];
    return rows.map(mapRate);
  }
  const rows = (await sql`
    SELECT * FROM exchange_rates WHERE company_id = ${companyId} ORDER BY effective_date DESC LIMIT ${limit}
  `) as Row[];
  return rows.map(mapRate);
}

export async function getLatestRate(companyId: string, 
  fromCurrency: string, toCurrency: string, asOfDate?: string
): Promise<number | null> {
  const date = asOfDate || new Date().toISOString().split('T')[0]!;
  const rows = (await sql`
    SELECT rate FROM exchange_rates
    WHERE company_id = ${companyId}
      AND from_currency = ${fromCurrency} AND to_currency = ${toCurrency}
      AND effective_date <= ${date}::DATE
    ORDER BY effective_date DESC LIMIT 1
  `) as Row[];
  return rows[0] ? Number(rows[0].rate) : null;
}

export async function setExchangeRate(companyId: string, input: {
  fromCurrency: string; toCurrency: string; rate: number;
  effectiveDate: string; source?: string;
}, userId: string): Promise<ExchangeRate> {
  const rows = (await sql`
    INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date, source, created_by)
    VALUES (${companyId}, ${input.fromCurrency}, ${input.toCurrency}, ${input.rate},
            ${input.effectiveDate}::DATE, ${input.source || 'manual'}, ${userId}::UUID)
    ON CONFLICT (company_id, from_currency, to_currency, effective_date)
    DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, created_by = EXCLUDED.created_by
    RETURNING *
  `) as Row[];
  log.info('Set exchange rate', {
    pair: `${input.fromCurrency}/${input.toCurrency}`,
    rate: input.rate, date: input.effectiveDate,
  }, 'accounting');
  return mapRate(rows[0]!);
}

export async function convertAmount(companyId: string, 
  amount: number, fromCurrency: string, toCurrency: string, asOfDate?: string
): Promise<{ converted: number; rate: number } | null> {
  if (fromCurrency === toCurrency) return { converted: amount, rate: 1 };
  const rate = await getLatestRate(companyId, fromCurrency, toCurrency, asOfDate);
  if (rate === null) return null;
  return { converted: Math.round(amount * rate * 100) / 100, rate };
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const rows = (await sql`
    SELECT setting_value FROM accounting_settings WHERE setting_key = ${key}
  `) as Row[];
  return rows[0] ? String(rows[0].setting_value) : null;
}

export async function setSetting(key: string, value: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO accounting_settings (setting_key, setting_value, updated_by)
    VALUES (${key}, ${value}, ${userId}::UUID)
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value,
      updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapCurrency(row: Row): Currency {
  return {
    code: String(row.code),
    name: String(row.name),
    symbol: String(row.symbol),
    decimalPlaces: Number(row.decimal_places),
    isActive: Boolean(row.is_active),
  };
}

function mapRate(row: Row): ExchangeRate {
  return {
    id: String(row.id),
    fromCurrency: String(row.from_currency),
    toCurrency: String(row.to_currency),
    rate: Number(row.rate),
    effectiveDate: row.effective_date instanceof Date
      ? row.effective_date.toISOString().split('T')[0]!
      : String(row.effective_date).split('T')[0]!,
    source: String(row.source || 'manual'),
  };
}
