/**
 * The currency and exchange rate a document may be written with (FX programme
 * PR0), for customer invoices, supplier invoices and credit notes alike.
 *
 * `companies.functional_currency` is the one authority for "own currency"
 * (migration 871 makes it NOT NULL and 'ZAR'); `default_currency` is only a
 * form default. Two refusals, both before any write:
 *
 * - A document in the functional currency converts at exactly 1. Any other
 *   rate let a caller shrink `functional_total`, the figure approval rules
 *   match on: a R500 000 bill at 0.0001 read as R50 (R-035 PR2 HIGH-1, which
 *   guarded bills only; invoices now too).
 * - A document in any other currency is refused unless the company has
 *   `fx_documents_enabled`. Until the FX programme lands functional posting
 *   and settlement, such a document posts its document figures as rands and
 *   cannot be settled. The database refuses the same thing
 *   (fx_document_currency_gate); this answers first, with a 400.
 */
import { sql } from '@/lib/neon';

type Query = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

export interface CompanyCurrency {
  functionalCurrency: string;
  fxDocumentsEnabled: boolean;
}

/** Caught as one class by the routes (a 400); each subclass carries its registered refusal code. */
export abstract class DocumentCurrencyError extends Error {
  abstract readonly code: string;
}

export class DocumentExchangeRateError extends DocumentCurrencyError {
  readonly code = 'EXCHANGE_RATE_INVALID';
  constructor(currencyCode: string, exchangeRate: number, noun: string) {
    super(`A ${currencyCode} ${noun} is in this company's own currency, so its exchange rate must be 1 (got ${exchangeRate}).`);
    this.name = 'DocumentExchangeRateError';
  }
}

export class ForeignCurrencyDisabledError extends DocumentCurrencyError {
  readonly code = 'FOREIGN_CURRENCY_DISABLED';
  constructor(currencyCode: string, functionalCurrency: string, noun: string) {
    super(`${currencyCode} ${noun}s are not enabled for this company yet. Issue the ${noun} in ${functionalCurrency}.`);
    this.name = 'ForeignCurrencyDisabledError';
  }
}

/** The pure rule. Throws a DocumentCurrencyError; returns the normalised pair. */
export function checkDocumentCurrency(
  company: CompanyCurrency,
  currencyCode: string | null | undefined,
  exchangeRate: number | null | undefined,
  noun: string,
): { currencyCode: string; exchangeRate: number } {
  const code = currencyCode?.trim().toUpperCase() || company.functionalCurrency;
  const rate = typeof exchangeRate === 'number' && exchangeRate > 0 ? exchangeRate : 1;
  if (code === company.functionalCurrency) {
    if (rate !== 1) throw new DocumentExchangeRateError(code, rate, noun);
  } else if (!company.fxDocumentsEnabled) {
    throw new ForeignCurrencyDisabledError(code, company.functionalCurrency, noun);
  }
  return { currencyCode: code, exchangeRate: rate };
}

/** The company's functional currency and switch. `q` is the caller's transaction when it has one. */
export async function loadCompanyCurrency(companyId: string, q: Query = sql): Promise<CompanyCurrency> {
  const rows = (await q`
    SELECT functional_currency, fx_documents_enabled FROM companies WHERE id = ${companyId}::UUID
  `) as { functional_currency: string; fx_documents_enabled: boolean }[];
  const row = rows[0];
  if (!row) throw new Error(`Company ${companyId} not found`);
  return { functionalCurrency: row.functional_currency, fxDocumentsEnabled: row.fx_documents_enabled === true };
}

export async function resolveDocumentCurrency(
  companyId: string,
  currencyCode: string | null | undefined,
  exchangeRate: number | null | undefined,
  noun: string,
): Promise<{ currencyCode: string; exchangeRate: number }> {
  return checkDocumentCurrency(await loadCompanyCurrency(companyId), currencyCode, exchangeRate, noun);
}

/** What every rand-charging payment route answers for a foreign-currency invoice. */
export const FOREIGN_INVOICE_ONLINE_PAYMENT =
  'This invoice is in a foreign currency, and online payment charges rands, so it cannot be paid online.';

/**
 * True when the customer invoice aliased `ci` is in a currency other than its
 * company's functional one. NULL `currency_code` is the functional currency
 * (migration 299's default). A company row the caller cannot read answers
 * true: refuse, not pass. The payment rails (Paystack, portal links) charge
 * rands, so they refuse a foreign invoice outright.
 */
export const invoiceForeignCurrencySql = () => sql`((
  SELECT COALESCE(upper(btrim(ci.currency_code)), co.functional_currency) IS DISTINCT FROM co.functional_currency
  FROM companies co WHERE co.id = ci.company_id) IS NOT FALSE)`;
