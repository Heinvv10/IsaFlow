/**
 * The currency and exchange rate a document may be written and POSTED with
 * (FX programme PR0), for customer invoices, supplier invoices and credit
 * notes alike.
 *
 * `companies.functional_currency` is the one authority for "own currency"
 * (migration 871 makes it NOT NULL and 'ZAR'); `default_currency` is only a
 * form default. The refusals, all before any write:
 *
 * - A currency code that is not three letters, or not a string at all, is
 *   refused (`CURRENCY_CODE_INVALID`). Blank means the functional currency,
 *   here and in the database (fx_row_is_foreign's NULLIF).
 * - A document in the functional currency converts at exactly 1. Any other
 *   rate let a caller shrink `functional_total`, the figure approval rules
 *   match on: a R500 000 bill at 0.0001 read as R50 (R-035 PR2 HIGH-1, which
 *   guarded bills only; invoices now too).
 * - A document in any other currency is refused unless the company has
 *   `fx_documents_enabled` — when it is written, and again when it is posted
 *   (`assertPostableCurrency`), because a foreign draft written while the
 *   switch was on would otherwise post its document figures as rands once it
 *   is off. The database refuses the same (fx_document_currency_gate); this
 *   answers first, with a 400.
 *
 * SETTLING a foreign document (amount_paid, a credit note's applied_amount)
 * is refused whatever the switch (`assertSettleableCurrency`): until FX PR3
 * the ledger cannot carry a foreign balance's movements, and
 * fx_settlement_refusal refuses the same, unconditionally, in the database.
 *
 * Credit notes are created with no currency input at all (the column takes
 * its 'ZAR' default), so creation has nothing to check here; a note linked
 * to a foreign invoice is refused by creditNoteLinkService instead.
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

export class CurrencyCodeInvalidError extends DocumentCurrencyError {
  readonly code = 'CURRENCY_CODE_INVALID';
  constructor() {
    super('currencyCode must be a three-letter ISO currency code, such as ZAR or USD.');
    this.name = 'CurrencyCodeInvalidError';
  }
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
    // Not "issue it in ZAR": relabelling a USD draft as ZAR keeps its USD figures, now read as rands.
    super(`${currencyCode} ${noun}s are not enabled for this company yet. To issue it in ${functionalCurrency}, `
      + `create it in ${functionalCurrency} with its amounts in ${functionalCurrency} — changing only the currency would book the ${currencyCode} figures as ${functionalCurrency}.`);
    this.name = 'ForeignCurrencyDisabledError';
  }
}

export class ForeignCurrencySettlementError extends DocumentCurrencyError {
  readonly code = 'FOREIGN_CURRENCY_SETTLEMENT';
  constructor(currencyCode: string, noun: string) {
    super(`This ${noun} is in ${currencyCode}, and settling a foreign-currency ${noun} is not supported yet.`);
    this.name = 'ForeignCurrencySettlementError';
  }
}

/** A caller's code: null when absent or blank; refused when not a three-letter string. */
function requestedCode(currencyCode: unknown): string | null {
  if (currencyCode === undefined || currencyCode === null) return null;
  if (typeof currencyCode !== 'string') throw new CurrencyCodeInvalidError();
  const code = currencyCode.trim().toUpperCase();
  if (code === '') return null;
  if (!/^[A-Z]{3}$/.test(code)) throw new CurrencyCodeInvalidError();
  return code;
}

/** A stored code, as fx_row_is_foreign reads it: trimmed, upper-cased, blank is NULL. */
const storedCode = (code: unknown): string | null => {
  const text = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return text === '' ? null : text;
};

/** The pure rule for a WRITE. Throws a DocumentCurrencyError; returns the normalised pair. */
export function checkDocumentCurrency(
  company: CompanyCurrency,
  currencyCode: unknown,
  exchangeRate: unknown,
  noun: string,
): { currencyCode: string; exchangeRate: number } {
  const code = requestedCode(currencyCode) ?? company.functionalCurrency;
  const rate = typeof exchangeRate === 'number' && exchangeRate > 0 ? exchangeRate : 1;
  if (code === company.functionalCurrency) {
    if (rate !== 1) throw new DocumentExchangeRateError(code, rate, noun);
  } else if (!company.fxDocumentsEnabled) {
    throw new ForeignCurrencyDisabledError(code, company.functionalCurrency, noun);
  }
  return { currencyCode: code, exchangeRate: rate };
}

/**
 * The pure rule for POSTING a stored document (or editing one): refused while
 * any of its currency columns is foreign and the company has not enabled them.
 */
export function assertPostableCurrency(company: CompanyCurrency, storedCodes: readonly unknown[], noun: string): void {
  if (company.fxDocumentsEnabled) return;
  const foreign = storedCodes.map(storedCode).find((c) => c !== null && c !== company.functionalCurrency);
  if (foreign) throw new ForeignCurrencyDisabledError(foreign, company.functionalCurrency, noun);
}

/** The pure rule for SETTLING a stored document: refused while any of its currency columns is foreign, whatever the switch. */
export function assertSettleableCurrency(company: CompanyCurrency, storedCodes: readonly unknown[], noun: string): void {
  const foreign = storedCodes.map(storedCode).find((c) => c !== null && c !== company.functionalCurrency);
  if (foreign) throw new ForeignCurrencySettlementError(foreign, noun);
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
  currencyCode: unknown,
  exchangeRate: unknown,
  noun: string,
): Promise<{ currencyCode: string; exchangeRate: number }> {
  return checkDocumentCurrency(await loadCompanyCurrency(companyId), currencyCode, exchangeRate, noun);
}

/** Loads the company and applies {@link assertPostableCurrency}; for the approve/post services. */
export async function assertDocumentPostable(companyId: string, storedCodes: readonly unknown[], noun: string): Promise<void> {
  assertPostableCurrency(await loadCompanyCurrency(companyId), storedCodes, noun);
}

/**
 * {@link assertDocumentPostable} for a document read by id: a supplier bill's
 * TWO currency columns (the mapped SupplierInvoice carries only the legacy
 * one), an invoice's or a credit note's one. Absent rows pass — the caller's
 * own read answers "not found".
 */
export async function assertStoredDocumentPostable(
  companyId: string, kind: StoredDocumentKind, id: string,
): Promise<void> {
  const row = await storedCurrencyRow(companyId, kind, id);
  if (row) await assertDocumentPostable(companyId, row.codes, row.noun);
}

/** {@link assertSettleableCurrency} for a document read by id; absent rows pass, as above. */
export async function assertStoredDocumentSettleable(
  companyId: string, kind: StoredDocumentKind, id: string,
): Promise<void> {
  const row = await storedCurrencyRow(companyId, kind, id);
  if (row) assertSettleableCurrency(await loadCompanyCurrency(companyId), row.codes, row.noun);
}

/** Whether every one of `docs` may be settled: for the paths that leave a foreign document unapplied rather than refuse. */
export async function storedDocumentsSettleable(
  companyId: string, docs: readonly (readonly [StoredDocumentKind, string])[],
): Promise<boolean> {
  const company = await loadCompanyCurrency(companyId);
  for (const [kind, id] of docs) {
    const row = await storedCurrencyRow(companyId, kind, id);
    if (row && row.codes.map(storedCode).some((c) => c !== null && c !== company.functionalCurrency)) return false;
  }
  return true;
}

type StoredDocumentKind = 'customer_invoice' | 'supplier_invoice' | 'credit_note';

async function storedCurrencyRow(
  companyId: string, kind: StoredDocumentKind, id: string,
): Promise<{ codes: unknown[]; noun: string } | null> {
  const rows = (kind === 'supplier_invoice'
    ? await sql`SELECT currency_code, currency FROM supplier_invoices WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`
    : kind === 'customer_invoice'
      ? await sql`SELECT currency_code FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`
      : await sql`SELECT currency FROM credit_notes WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) return null;
  return { codes: Object.values(row), noun: kind === 'supplier_invoice' ? 'bill' : kind === 'customer_invoice' ? 'invoice' : 'credit note' };
}

/**
 * The journal half of {@link assertStoredDocumentPostable}: posting a DRAFT
 * journal that a foreign document already links to (gl_journal_entry_id),
 * while the company has not enabled them — through `post_journal` or the
 * journal screen rather than the document's own approve — books that
 * document's foreign figures as rands. Whatever the journal's source: a link
 * is a link (round-3 probe B3, a manual-source journal). Only this company's
 * documents count. A journal no document links to yet (the approve paths link
 * after posting) passes; those paths check the document themselves.
 */
export async function assertJournalDocumentsPostable(companyId: string, journalId: string): Promise<void> {
  const rows = (await sql`
    SELECT 'invoice' AS noun, currency_code AS a, NULL::TEXT AS b FROM customer_invoices
     WHERE gl_journal_entry_id = ${journalId}::UUID AND company_id = ${companyId}::UUID
    UNION ALL
    SELECT 'bill', currency_code, currency FROM supplier_invoices
     WHERE gl_journal_entry_id = ${journalId}::UUID AND company_id = ${companyId}::UUID
    UNION ALL
    SELECT 'credit note', currency, NULL FROM credit_notes
     WHERE gl_journal_entry_id = ${journalId}::UUID AND company_id = ${companyId}::UUID
  `) as { noun: string; a: unknown; b: unknown }[];
  if (rows.length === 0) return;
  const company = await loadCompanyCurrency(companyId);
  for (const row of rows) assertPostableCurrency(company, [row.a, row.b], row.noun);
}

/** What every rand-charging payment route answers for a foreign-currency invoice. */
export const FOREIGN_INVOICE_ONLINE_PAYMENT =
  'This invoice is in a foreign currency, and online payment charges rands, so it cannot be paid online.';

/**
 * True when the customer invoice aliased `ci` is in a currency other than its
 * company's functional one; the twin of fx_row_is_foreign. NULL or blank is
 * the functional currency. A company row the caller cannot read answers true:
 * refuse, not pass. The payment rails refuse a foreign invoice outright; the
 * open-document readers leave it out of every automatic settlement.
 */
export const invoiceForeignCurrencySql = () => sql`((
  SELECT COALESCE(NULLIF(upper(btrim(ci.currency_code)), ''), co.functional_currency) IS DISTINCT FROM co.functional_currency
  FROM companies co WHERE co.id = ci.company_id) IS NOT FALSE)`;

/** {@link invoiceForeignCurrencySql} for the supplier invoice aliased `si`, on either currency column. */
export const billForeignCurrencySql = () => sql`((
  SELECT COALESCE(NULLIF(upper(btrim(si.currency_code)), ''), co.functional_currency) IS DISTINCT FROM co.functional_currency
      OR COALESCE(NULLIF(upper(btrim(si.currency)), ''), co.functional_currency) IS DISTINCT FROM co.functional_currency
  FROM companies co WHERE co.id = si.company_id) IS NOT FALSE)`;

/** {@link invoiceForeignCurrencySql} for the credit note aliased `cn`: automatic settlement leaves it out. */
export const creditNoteForeignCurrencySql = () => sql`((
  SELECT COALESCE(NULLIF(upper(btrim(cn.currency)), ''), co.functional_currency) IS DISTINCT FROM co.functional_currency
  FROM companies co WHERE co.id = cn.company_id) IS NOT FALSE)`;
