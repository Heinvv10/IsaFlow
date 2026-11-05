/**
 * Which terms a new document is dated by: the contact's own, else the company's default (migration 960; Hein,
 * 2026-11-05: a contact whose terms are not set uses the company default, which starts at 30 days from invoice).
 * The one server-side place a document creator turns a contact and an invoice date into a due date.
 *
 * The default lives in `accounting_settings` (key `default_payment_terms`, JSON), the company-scoped store the app pools
 * may write: `companies` is column-level read-only for them since migration 936, and a new column there would need a
 * rule change in app_pool_reach_violations() as well. No row means 30 days from invoice, every company's start.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  COMPANY_DEFAULT_TERMS_KEY, PaymentTermsError, companyTermsFromSetting, companyTermsSetting, dueDateWithDefault, parseTermsWrite,
  type Terms,
} from '../shared/paymentTerms';
import { ContactValidationError } from './contactValidationError';

export type ContactKind = 'customer' | 'supplier';

/** The company's default terms (30 days from invoice when none is set, so a document is never undated). */
export async function getCompanyDefaultTerms(companyId: string): Promise<Terms> {
  const [row] = (await sql`
    SELECT value FROM accounting_settings WHERE company_id = ${companyId}::UUID AND key = ${COMPANY_DEFAULT_TERMS_KEY}
  `) as DbRow[];
  return companyTermsFromSetting(row?.value, companyId);
}

/** Set the company default. Refuses anything but a whole number from 0 to 999 with a type (no "not set" for a default). */
export async function setCompanyDefaultTerms(companyId: string, days: unknown, type: unknown): Promise<Terms> {
  try {
    const w = parseTermsWrite(typeof days === 'number' ? days : Number.NaN, typeof type === 'string' ? type : undefined);
    if (w.kind !== 'set') throw new PaymentTermsError('Choose both the number and what it counts');
    const terms: Terms = { days: w.days, type: w.type };
    await sql`
      INSERT INTO accounting_settings (company_id, key, value)
      VALUES (${companyId}::UUID, ${COMPANY_DEFAULT_TERMS_KEY}, ${companyTermsSetting(terms)})
      ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return terms;
  } catch (err) {
    if (err instanceof PaymentTermsError) throw new ContactValidationError(err.message);
    throw err;
  }
}

/** One contact's raw terms and its company's default: one query, scoped to the company. */
export async function contactTerms(
  companyId: string, kind: ContactKind, contactId: string | null,
): Promise<{ days: number | null; type: string | null; companyDefault: Terms }> {
  const [row] = (kind === 'customer'
    ? await sql`
        SELECT c.payment_terms, c.payment_terms_type, s.value AS company_default_terms
        FROM (SELECT 1) one
        LEFT JOIN customers c ON c.id = ${contactId}::UUID AND c.company_id = ${companyId}::UUID
        LEFT JOIN accounting_settings s ON s.company_id = ${companyId}::UUID AND s.key = ${COMPANY_DEFAULT_TERMS_KEY}`
    : await sql`
        SELECT c.payment_terms, c.payment_terms_type, s.value AS company_default_terms
        FROM (SELECT 1) one
        LEFT JOIN suppliers c ON c.id = ${contactId}::UUID AND c.company_id = ${companyId}::UUID
        LEFT JOIN accounting_settings s ON s.company_id = ${companyId}::UUID AND s.key = ${COMPANY_DEFAULT_TERMS_KEY}`) as DbRow[];
  return {
    days: row?.payment_terms == null ? null : Number(row.payment_terms),
    type: row?.payment_terms_type == null ? null : String(row.payment_terms_type),
    companyDefault: companyTermsFromSetting(row?.company_default_terms, companyId),
  };
}

/** The due date for a document to this contact dated `invoiceDate`: its terms, else the company default. */
export async function dueDateForContact(
  companyId: string, kind: ContactKind, contactId: string | null, invoiceDate: string,
): Promise<string | null> {
  const t = await contactTerms(companyId, kind, contactId);
  return dueDateWithDefault(invoiceDate, t.days, t.type, t.companyDefault);
}
