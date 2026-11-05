/** What the supplier and customer form mappings share: reading a stored record's values into the form's strings. */
import { readTerms } from '@/modules/accounting/services/shared/paymentTerms';
import { COMPANY_DEFAULT_TERMS } from '@/components/accounting/paymentTermsForm';

export type Row = Record<string, unknown>;

/** A stored value as the form's string ('' for none). */
export const text = (row: Row, key: string): string => (row[key] === null || row[key] === undefined ? '' : String(row[key]));

export type StrategyValue = 'off' | 'oldest' | 'newest';

export function strategyOf(value: unknown): StrategyValue {
  return value === 'oldest' || value === 'newest' ? value : 'off';
}

/**
 * Stored terms as the form's pair. Legacy shapes read as they always meant (readTerms); terms that are not set, or
 * unreadable, show as "Use company default".
 */
export function termsToForm(days: unknown, type: unknown): { payment_terms: string; payment_terms_type: string } {
  const t = readTerms(days === null || days === undefined ? null : Number(days), typeof type === 'string' ? type : null);
  return t ? { payment_terms: String(t.days), payment_terms_type: t.type } : { ...COMPANY_DEFAULT_TERMS };
}

/**
 * The fields of an edit body the user changed since the page loaded (`after` against `before`, both built the same way).
 * An edit sends only these: the whole form would overwrite what someone else saved meanwhile, and would clear a field this
 * page could not show. The terms travel as a pair: a change to either sends both.
 */
export function changedBody(before: Row, after: Row): Row {
  const out: Row = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  if ('payment_terms' in out || 'payment_terms_type' in out) {
    for (const key of ['payment_terms', 'payment_terms_type']) if (key in after) out[key] = after[key];
  }
  return out;
}
