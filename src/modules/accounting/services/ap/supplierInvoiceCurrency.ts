/**
 * The currency and exchange rate a new supplier invoice is stored with (R-035
 * PR2 review HIGH-1).
 *
 * A bill in the company's own currency converts at exactly 1. Accepting any
 * other rate let a caller shrink `functional_total` — the ZAR figure approval
 * rules were matched on — while approval still posted `total_amount`: a
 * R500 000 bill at 0.0001 read as R50. The gate now matches on the larger of
 * the two (approval_supplier_invoice_gate_amount); this refuses the rate at
 * the door, before any write, so the stored figures cannot disagree.
 */
import { sql } from '@/lib/neon';

export class SupplierInvoiceExchangeRateError extends Error {
  readonly code = 'EXCHANGE_RATE_INVALID';
  constructor(currencyCode: string, exchangeRate: number) {
    super(`A ${currencyCode} bill is in this company's own currency, so its exchange rate must be 1 (got ${exchangeRate}).`);
    this.name = 'SupplierInvoiceExchangeRateError';
  }
}

export async function resolveBillCurrency(
  companyId: string, currencyCode: string | undefined, exchangeRate: number | undefined,
): Promise<{ currencyCode: string; exchangeRate: number }> {
  const code = currencyCode?.trim().toUpperCase() || 'ZAR';
  const rate = typeof exchangeRate === 'number' && exchangeRate > 0 ? exchangeRate : 1.0;
  const [company] = (await sql`
    SELECT COALESCE(NULLIF(upper(btrim(default_currency)), ''), 'ZAR') AS currency
    FROM companies WHERE id = ${companyId}::UUID
  `) as { currency: string }[];
  if (code === (company?.currency ?? 'ZAR') && rate !== 1) throw new SupplierInvoiceExchangeRateError(code, rate);
  return { currencyCode: code, exchangeRate: rate };
}
