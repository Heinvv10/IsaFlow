/**
 * The VAT on a quote's lines (audit 11 Nov 2026 item 5).
 *
 * Each line carries its own rate. A line sent without one takes the company's: 0 for a company that is not a VAT vendor
 * (`companies.vat_period` / `vat_system_type`, vatPeriodHelper), else the standard 15%. It used to be 15% always.
 *
 * Lines are priced as invoice lines are (invoiceLineAmount), and the tax is invoiceTotals over the lines of each rate,
 * summed, so a single-rate quote totals exactly as the invoice it converts to.
 */
import { sql, type DbRow } from '@/lib/neon';
import { isVatRegistered } from '@/modules/bureau/services/vatPeriodHelper';
import { invoiceLineAmount, invoiceTotals } from './invoiceLineAmount';

export const STANDARD_VAT_RATE = 15;

interface QuoteLineIn { quantity: number; unitPrice: number; taxRate?: number | null }

/** Why a supplied rate is refused, or null. An omitted rate (undefined / null) is not refused: it takes the default. */
export function taxRateProblem(rate: unknown): string | null {
  if (rate === undefined || rate === null) return null;
  const n = typeof rate === 'number' || (typeof rate === 'string' && rate.trim() !== '') ? Number(rate) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? null : 'VAT rate must be a number from 0 to 100';
}

/** The rate for a line sent without one: 0 for a company that is not VAT registered, else 15. */
export async function defaultQuoteTaxRate(companyId: string): Promise<number> {
  const [row] = (await sql`SELECT vat_period, vat_system_type FROM companies WHERE id = ${companyId}::UUID`) as DbRow[];
  if (!row) return STANDARD_VAT_RATE;
  return isVatRegistered(row.vat_period as string | null, row.vat_system_type as string | null) ? STANDARD_VAT_RATE : 0;
}

/** The lines with every rate set; the company is read only when a line omits its rate. */
export async function withQuoteTaxRates<L extends QuoteLineIn>(companyId: string, lines: readonly L[]): Promise<(L & { taxRate: number })[]> {
  const fallback = lines.some((l) => l.taxRate == null) ? await defaultQuoteTaxRate(companyId) : STANDARD_VAT_RATE;
  return lines.map((l) => ({ ...l, taxRate: l.taxRate == null ? fallback : Number(l.taxRate) }));
}

/** The line's ex-VAT amount, as an invoice line of it is priced. */
export const quoteLineAmount = (l: QuoteLineIn): number => invoiceLineAmount(Number(l.quantity), Number(l.unitPrice));

const toCents = (n: number): number => Math.round(n * 100);

/** Header totals: per rate as invoiceTotals, summed in cents. */
export function quoteTotals(lines: readonly (QuoteLineIn & { taxRate: number })[]): { subtotal: number; taxAmount: number; total: number } {
  const byRate = new Map<number, number[]>();
  for (const l of lines) byRate.set(l.taxRate, [...(byRate.get(l.taxRate) ?? []), quoteLineAmount(l)]);
  let subtotal = 0;
  let tax = 0;
  for (const [rate, amounts] of byRate) {
    const t = invoiceTotals(amounts, rate);
    subtotal += toCents(t.subtotal);
    tax += toCents(t.tax);
  }
  return { subtotal: subtotal / 100, taxAmount: tax / 100, total: (subtotal + tax) / 100 };
}
