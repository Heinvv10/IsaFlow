/**
 * Currency & Exchange Rate Service
 * Multi-currency foundation for accounting
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { clampLimit } from '@/lib/pagination';

type Row = DbRow;

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
  // Returns global currencies (company_id IS NULL) plus any company-specific overrides.
  const rows = activeOnly
    ? ((await sql`
        SELECT * FROM currencies
        WHERE (company_id = ${companyId} OR company_id IS NULL) AND is_active = true
        ORDER BY code
      `) as Row[])
    : ((await sql`
        SELECT * FROM currencies
        WHERE (company_id = ${companyId} OR company_id IS NULL)
        ORDER BY code
      `) as Row[]);
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
  const result = (await sql`UPDATE currencies SET is_active = ${isActive} WHERE code = ${code} AND company_id = ${companyId} RETURNING code`) as Row[];
  if (result.length === 0) throw new Error(`Currency not found: ${code}`);
}

// ── Exchange Rates ──────────────────────────────────────────────────────────

export async function getExchangeRates(companyId: string, filters?: {
  fromCurrency?: string; toCurrency?: string; limit?: number;
}): Promise<ExchangeRate[]> {
  // Defense in depth: even if a future caller forgets to clamp, cap here too.
  const limit = clampLimit(filters?.limit, 100, 1000);

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
            ${input.effectiveDate}::DATE, ${input.source || 'manual'}, ${userId})
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

export async function deleteExchangeRate(companyId: string, id: string): Promise<void> {
  const rows = (await sql`
    DELETE FROM exchange_rates
    WHERE id = ${id}::UUID AND company_id = ${companyId}
    RETURNING id
  `) as Row[];
  if (rows.length === 0) {
    throw new Error(`Exchange rate ${id} not found for company ${companyId}`);
  }
  log.info('Deleted exchange rate', { id, companyId }, 'accounting');
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

export async function getSetting(key: string, companyId?: string): Promise<string | null> {
  // DB schema uses 'key'/'value' columns (created by migration 255_fix_missing_schema)
  const rows = companyId
    ? (await sql`
        SELECT value FROM accounting_settings WHERE key = ${key} AND company_id = ${companyId}::UUID
      `) as Row[]
    : (await sql`
        SELECT value FROM accounting_settings WHERE key = ${key}
      `) as Row[];
  return rows[0] ? String(rows[0].value) : null;
}

export async function setSetting(key: string, value: string, _userId: string, companyId?: string): Promise<void> {
  // DB schema uses 'key'/'value' columns, UNIQUE(company_id, key) — migration 255_fix_missing_schema
  if (companyId) {
    await sql`
      INSERT INTO accounting_settings (company_id, key, value)
      VALUES (${companyId}::UUID, ${key}, ${value})
      ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  } else {
    // Global setting (no company scope) — upsert by checking existence first
    const existing = (await sql`
      SELECT id FROM accounting_settings WHERE key = ${key} AND company_id IS NULL LIMIT 1
    `) as Row[];
    if (existing[0]) {
      await sql`
        UPDATE accounting_settings SET value = ${value}, updated_at = NOW()
        WHERE key = ${key} AND company_id IS NULL
      `;
    } else {
      await sql`
        INSERT INTO accounting_settings (key, value) VALUES (${key}, ${value})
      `;
    }
  }
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
